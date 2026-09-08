use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use shared_proto::{
    AUDIO_HEADER_LENGTH, AudioFormatContract, AudioFrameHeader, BrokerCoreMessage, ChannelId,
    ControlRequest, ControlResponse, EndpointId, LoopbackEndpoint, NativeRequest, NativeResponse,
    PairChallenge, PairResult, ProfileId, ProtocolError, ProtocolRange, ProtocolVersion,
    SessionGrant, SessionId,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::{MissedTickBehavior, interval, timeout};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::clocked_mixer::ClockedMixer;
use crate::microphone::{MicrophoneCapture, MicrophoneError};
use crate::mixer::{MixEndpoint, PCM_FRAME_SAMPLES};
use crate::pairing::PairingRegistry;

const MAX_AUDIO_PAYLOAD_BYTES: usize = 1920;
const PAIRING_TTL: Duration = Duration::from_secs(120);
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone)]
pub struct HubConfig {
    pub bind_addr: SocketAddr,
    pub max_sessions: usize,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 39_201),
            max_sessions: 24,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HubStatus {
    pub bind_addr: SocketAddr,
    pub active_sessions: usize,
    pub accepted_audio_frames: u64,
    pub rejected_audio_frames: u64,
    pub authenticated_audio_connections: u64,
    pub pending_pair_codes: Vec<String>,
    pub paired_profiles: usize,
    pub microphone_active: bool,
    pub diagnostic_log_path: String,
    pub audio_queue_underruns: u64,
    pub audio_queue_dropped_frames: u64,
    pub audio_slow_disconnects: u64,
}

#[derive(Debug, Clone)]
pub struct SessionAdmission {
    pub session_id: SessionId,
    pub profile_id: ProfileId,
    pub endpoint_id: EndpointId,
    pub channel_id: ChannelId,
    pub epoch: u64,
    pub session_secret_b64: String,
    pub websocket_url: String,
    pub expires_at: SystemTime,
}

#[derive(Debug, Clone)]
struct SessionRecord {
    profile_id: ProfileId,
    endpoint_id: EndpointId,
    channel_id: ChannelId,
    epoch: u64,
    session_secret_b64: String,
    expires_at: SystemTime,
}

#[derive(Debug, Default)]
struct Metrics {
    accepted_audio_frames: u64,
    rejected_audio_frames: u64,
    authenticated_audio_connections: u64,
    audio_slow_disconnects: u64,
}

#[derive(Clone)]
pub struct HubService {
    config: HubConfig,
    sessions: Arc<Mutex<HashMap<SessionId, SessionRecord>>>,
    mixer: Arc<Mutex<ClockedMixer>>,
    audio_clients: Arc<Mutex<HashMap<SessionId, mpsc::Sender<Vec<u8>>>>>,
    metrics: Arc<Mutex<Metrics>>,
    pairings: Arc<Mutex<PairingRegistry>>,
    microphone: Arc<Mutex<Option<MicrophoneCapture>>>,
}

impl HubService {
    pub fn new(config: HubConfig) -> Self {
        Self {
            config,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            mixer: Arc::new(Mutex::new(microphone_matrix())),
            audio_clients: Arc::new(Mutex::new(HashMap::new())),
            metrics: Arc::new(Mutex::new(Metrics::default())),
            pairings: Arc::new(Mutex::new(PairingRegistry::default())),
            microphone: Arc::new(Mutex::new(None)),
        }
    }

    pub fn ingest_microphone_frame(
        &self,
        channel_id: ChannelId,
        samples: [f32; PCM_FRAME_SAMPLES],
    ) {
        let endpoint = MixEndpoint {
            endpoint_id: Uuid::nil(),
            channel_id,
        };
        let _ = self.mixer.lock().enqueue(endpoint, samples);
    }

    pub fn start_microphone(&self) -> Result<bool, MicrophoneError> {
        let mut microphone = self.microphone.lock();
        if microphone.is_some() {
            return Ok(false);
        }
        *microphone = Some(MicrophoneCapture::start_default(self.clone())?);
        Ok(true)
    }

    pub fn stop_microphone(&self) -> bool {
        let Some(mut microphone) = self.microphone.lock().take() else {
            return false;
        };
        microphone.stop();
        let mut mixer = self.mixer.lock();
        for channel_id in [
            ChannelId::CHANNEL_1,
            ChannelId::CHANNEL_2,
            ChannelId::CHANNEL_3,
        ] {
            let endpoint = MixEndpoint {
                endpoint_id: Uuid::nil(),
                channel_id,
            };
            mixer.remove(endpoint);
            mixer.register(endpoint);
        }
        true
    }

    pub fn handle_control(
        &self,
        request: ControlRequest,
        core_instance_id: Uuid,
    ) -> BrokerCoreMessage {
        let profile_id = request.profile_id;
        let response = match request.message {
            NativeRequest::Hello(message) => {
                let request_id = message.request_id;
                if !protocol_is_compatible(message.protocol) {
                    NativeResponse::Error(ProtocolError { request_id: Some(request_id), code: "protocol_incompatible".to_owned(), action_required: Some("Update Meet Bridge Hub and the Chrome extension to compatible versions.".to_owned()) })
                } else {
                    let code = make_confirmation_code().unwrap_or_else(|_| "000000".to_owned());
                    let expires_at = SystemTime::now() + PAIRING_TTL;
                    let started = self.pairings.lock().begin_if_unpaired(
                        request_id,
                        profile_id,
                        code.clone(),
                        expires_at,
                    );
                    if started {
                        NativeResponse::PairChallenge(PairChallenge {
                            request_id,
                            hub_instance_id: core_instance_id,
                            hub_public_key_b64: String::new(),
                            confirmation_code: code,
                            expires_at_unix_ms: unix_millis(expires_at).to_string(),
                        })
                    } else {
                        NativeResponse::PairResult(PairResult {
                            request_id,
                            profile_id,
                            paired: true,
                            anonymous_alias: format!("Profile-{}", &profile_id.to_string()[..8]),
                            hub_signature_b64: String::new(),
                        })
                    }
                }
            }
            NativeRequest::PairRequest(message) => {
                let request_id = message.request_id;
                let code = make_confirmation_code().unwrap_or_else(|_| "000000".to_owned());
                let expires_at = SystemTime::now() + PAIRING_TTL;
                self.pairings
                    .lock()
                    .begin_for(request_id, profile_id, code.clone(), expires_at);
                NativeResponse::PairChallenge(PairChallenge {
                    request_id,
                    hub_instance_id: core_instance_id,
                    hub_public_key_b64: String::new(),
                    confirmation_code: code,
                    expires_at_unix_ms: unix_millis(expires_at).to_string(),
                })
            }
            NativeRequest::PairDecision(decision) => {
                let paired = decision.approved
                    && self.pairings.lock().approve(
                        decision.request_id,
                        profile_id,
                        &decision.confirmation_code,
                    );
                NativeResponse::PairResult(PairResult {
                    request_id: decision.request_id,
                    profile_id,
                    paired,
                    anonymous_alias: format!("Profile-{}", &profile_id.to_string()[..8]),
                    hub_signature_b64: String::new(),
                })
            }
            NativeRequest::SessionRequest(session) => {
                if !protocol_is_compatible(session.protocol) {
                    NativeResponse::Error(ProtocolError { request_id: Some(session.request_id), code: "protocol_incompatible".to_owned(), action_required: Some("Update Meet Bridge Hub and the Chrome extension to compatible versions.".to_owned()) })
                } else if !self.pairings.lock().is_paired(profile_id) {
                    NativeResponse::Error(ProtocolError {
                        request_id: Some(session.request_id),
                        code: "pairing_required".to_owned(),
                        action_required: Some("Confirm pairing in Meet Bridge Hub.".to_owned()),
                    })
                } else {
                    match self.admit_session(profile_id, session.endpoint_id, session.channel_id, 1)
                    {
                        Ok(admission) => NativeResponse::SessionGrant(SessionGrant {
                            request_id: session.request_id,
                            session_id: admission.session_id,
                            profile_id,
                            endpoint_id: admission.endpoint_id,
                            channel_id: admission.channel_id,
                            epoch: admission.epoch.to_string(),
                            endpoint: LoopbackEndpoint {
                                host: "127.0.0.1".to_owned(),
                                port: self.config.bind_addr.port(),
                                path: "/audio".to_owned(),
                            },
                            ticket_id_b64: String::new(),
                            session_secret_b64: shared_proto::SensitiveBase64(
                                admission.session_secret_b64,
                            ),
                            expires_at_unix_ms: unix_millis(admission.expires_at).to_string(),
                            audio: AudioFormatContract {
                                sample_rate: 48_000,
                                channels: 1,
                                sample_format: "Float32Le".to_owned(),
                                frame_samples: 480,
                            },
                            feature_bits: "0".to_owned(),
                        }),
                        Err(error) => NativeResponse::Error(ProtocolError {
                            request_id: Some(session.request_id),
                            code: "session_rejected".to_owned(),
                            action_required: Some(error.to_string()),
                        }),
                    }
                }
            }
        };
        BrokerCoreMessage::ControlResponse(ControlResponse {
            broker_instance_id: request.broker_instance_id,
            profile_id,
            message: response,
        })
    }

    pub fn admit_session(
        &self,
        profile_id: ProfileId,
        endpoint_id: EndpointId,
        channel_id: ChannelId,
        epoch: u64,
    ) -> Result<SessionAdmission, AdmissionError> {
        if !channel_id.is_valid() {
            return Err(AdmissionError::InvalidChannel);
        }

        let mut sessions = self.sessions.lock();
        let replaced = sessions
            .iter()
            .filter_map(|(id, session)| {
                (session.profile_id == profile_id && session.endpoint_id == endpoint_id)
                    .then_some(*id)
            })
            .collect::<Vec<_>>();
        let session_secret_b64 = make_secret()?;
        for id in replaced {
            if let Some(old) = sessions.remove(&id) {
                self.audio_clients.lock().remove(&id);
                self.mixer.lock().remove(MixEndpoint {
                    endpoint_id: old.endpoint_id,
                    channel_id: old.channel_id,
                });
            }
        }
        if sessions.len() >= self.config.max_sessions {
            return Err(AdmissionError::CapacityReached);
        }

        let session_id = Uuid::new_v4();
        let expires_at = SystemTime::now() + SESSION_TTL;
        sessions.insert(
            session_id,
            SessionRecord {
                profile_id,
                endpoint_id,
                channel_id,
                epoch,
                session_secret_b64: session_secret_b64.clone(),
                expires_at,
            },
        );
        self.mixer.lock().register(MixEndpoint {
            endpoint_id,
            channel_id,
        });

        Ok(SessionAdmission {
            session_id,
            profile_id,
            endpoint_id,
            channel_id,
            epoch,
            session_secret_b64,
            websocket_url: format!("ws://{}/audio", self.config.bind_addr),
            expires_at,
        })
    }

    pub fn revoke_session(&self, session_id: SessionId) -> bool {
        let mut sessions = self.sessions.lock();
        let removed = sessions.remove(&session_id);
        if let Some(session) = removed {
            self.audio_clients.lock().remove(&session_id);
            self.mixer.lock().remove(MixEndpoint {
                endpoint_id: session.endpoint_id,
                channel_id: session.channel_id,
            });
            true
        } else {
            false
        }
    }

    pub fn revoke_all_sessions(&self) -> usize {
        let session_ids = self.sessions.lock().keys().copied().collect::<Vec<_>>();
        let count = session_ids.len();
        for session_id in session_ids {
            self.revoke_session(session_id);
        }
        count
    }

    pub fn status(&self) -> HubStatus {
        let (audio_queue_underruns, audio_queue_dropped_frames) = {
            let mixer = self.mixer.lock();
            (mixer.underruns, mixer.dropped_frames)
        };
        let metrics = self.metrics.lock();
        let mut pairings = self.pairings.lock();
        HubStatus {
            bind_addr: self.config.bind_addr,
            active_sessions: self.sessions.lock().len(),
            accepted_audio_frames: metrics.accepted_audio_frames,
            rejected_audio_frames: metrics.rejected_audio_frames,
            authenticated_audio_connections: metrics.authenticated_audio_connections,
            pending_pair_codes: pairings.pending_codes(),
            paired_profiles: pairings.paired_count(),
            microphone_active: self.microphone.lock().is_some(),
            diagnostic_log_path: diagnostic_log_path().display().to_string(),
            audio_queue_underruns,
            audio_queue_dropped_frames,
            audio_slow_disconnects: metrics.audio_slow_disconnects,
        }
    }

    pub async fn serve(self) -> std::io::Result<()> {
        let listener = TcpListener::bind(self.config.bind_addr).await?;
        #[cfg(unix)]
        {
            let control_path = crate::control_socket::control_socket_path()?;
            let control_core_id = Uuid::new_v4();
            tokio::try_join!(
                self.clone().serve_listener(listener),
                crate::control_socket::serve_control_endpoint(control_path, control_core_id, self),
            )?;
            Ok(())
        }
        #[cfg(not(unix))]
        {
            #[cfg(windows)]
            {
                let control_core_id = Uuid::new_v4();
                tokio::try_join!(
                    self.clone().serve_listener(listener),
                    crate::control_socket::serve_control_pipe(control_core_id, self),
                )?;
                Ok(())
            }
            #[cfg(not(windows))]
            self.serve_listener(listener).await
        }
    }

    pub async fn serve_listener(self, listener: TcpListener) -> std::io::Result<()> {
        let mut clock = interval(Duration::from_millis(10));
        clock.set_missed_tick_behavior(MissedTickBehavior::Burst);
        let mut sequence = 0_u64;
        loop {
            let (stream, peer_addr) = tokio::select! {
                accepted = listener.accept() => accepted?,
                _ = clock.tick() => {
                    self.mix_tick(sequence);
                    sequence = sequence.wrapping_add(1);
                    continue;
                }
            };
            if !peer_addr.ip().is_loopback() {
                continue;
            }
            let hub = self.clone();
            tokio::spawn(async move {
                if let Err(error) = hub.handle_connection(stream).await {
                    debug!(%error, "loopback audio connection closed");
                }
            });
        }
    }

    fn mix_tick(&self, sequence: u64) {
        let mut slow = Vec::new();
        let underrun = {
            let sessions = self.sessions.lock();
            let clients = self.audio_clients.lock();
            let mut mixer = self.mixer.lock();
            let before = mixer.underruns;
            mixer.advance();
            for (id, sender) in clients.iter() {
                let Some(session) = sessions.get(id) else {
                    continue;
                };
                let endpoint = MixEndpoint {
                    endpoint_id: session.endpoint_id,
                    channel_id: session.channel_id,
                };
                let frame = encode_downlink_frame(session, mixer.mix_for(endpoint), sequence);
                if sender.try_send(frame).is_err() {
                    slow.push(*id);
                }
            }
            mixer.underruns > before
        };
        if underrun {
            write_diagnostic_event("audio_input_underrun");
        }
        for id in slow {
            self.metrics.lock().audio_slow_disconnects += 1;
            write_diagnostic_event("audio_output_backpressure");
            self.revoke_session(id);
        }
    }

    async fn handle_connection(&self, stream: TcpStream) -> Result<(), ConnectionError> {
        stream
            .set_nodelay(true)
            .map_err(ConnectionError::Transport)?;
        let mut socket = accept_async(stream)
            .await
            .map_err(ConnectionError::WebSocket)?;
        let Some(Ok(Message::Text(text))) = socket.next().await else {
            return Err(ConnectionError::AuthenticationRequired);
        };
        let auth: AudioAuth =
            serde_json::from_str(&text).map_err(ConnectionError::AuthenticationPayload)?;
        let Some((session_id, session)) = self.authenticate(&auth) else {
            write_diagnostic_event("audio_auth_rejected");
            socket
                .close(None)
                .await
                .map_err(ConnectionError::WebSocket)?;
            return Err(ConnectionError::RejectedAuthentication);
        };
        let (sender, mut downlinks) = mpsc::channel(32);
        {
            let sessions = self.sessions.lock();
            let mut clients = self.audio_clients.lock();
            if !sessions.contains_key(&session_id) || clients.contains_key(&session_id) {
                return Err(ConnectionError::RejectedAuthentication);
            }
            clients.insert(session_id, sender);
        }
        self.metrics.lock().authenticated_audio_connections += 1;
        write_diagnostic_event("audio_authenticated");

        let result = async {
        socket
            .send(Message::Text("{\"type\":\"AUDIO_READY\"}".into()))
            .await
            .map_err(ConnectionError::WebSocket)?;

        loop {
            let message = tokio::select! {
                message = socket.next() => {
                    let Some(message) = message else { break };
                    message
                },
                output = downlinks.recv() => {
                    let Some(output) = output else { break };
                    if !self.sessions.lock().contains_key(&session_id) { break; }
                    match timeout(Duration::from_secs(2), socket.send(Message::Binary(output.into()))).await {
                        Ok(Ok(())) => {},
                        _ => { write_diagnostic_event("audio_output_send_failed"); break; }
                    }
                    continue;
                }
            };
            let message = match message {
                Ok(message) => message,
                Err(error) => {
                    debug!(%error, "audio websocket closed with an error");
                    break;
                }
            };
            match message {
                Message::Binary(frame) => {
                    self.process_audio_frame(session_id, &session, &frame);
                }
                Message::Close(_) => break,
                Message::Ping(payload) => {
                    if socket.send(Message::Pong(payload)).await.is_err() {
                        break;
                    }
                }
                _ => self.reject_frame(),
            }
        }
        Ok(())
        }.await;
        {
            let mut metrics = self.metrics.lock();
            metrics.authenticated_audio_connections =
                metrics.authenticated_audio_connections.saturating_sub(1);
        }
        write_diagnostic_event("audio_disconnected");
        self.revoke_session(session_id);
        result
    }

    fn authenticate(&self, auth: &AudioAuth) -> Option<(SessionId, SessionRecord)> {
        let session_id = Uuid::parse_str(&auth.session_id).ok()?;
        let session = self.sessions.lock().get(&session_id).cloned()?;
        if session.expires_at <= SystemTime::now() {
            self.revoke_session(session_id);
            return None;
        }
        if session.session_secret_b64 == auth.session_secret_b64 {
            Some((session_id, session))
        } else {
            None
        }
    }

    fn process_audio_frame(&self, session_id: SessionId, session: &SessionRecord, frame: &[u8]) {
        let header = AudioFrameHeader::from_bytes(frame).ok();
        let accepted = header.is_some_and(|header| {
            let payload_offset = usize::from(AUDIO_HEADER_LENGTH);
            let payload_length = usize::try_from(header.payload_length).unwrap_or(usize::MAX);
            frame.len() == payload_offset.saturating_add(payload_length)
                && payload_length == MAX_AUDIO_PAYLOAD_BYTES
                && header.samples_per_channel == PCM_FRAME_SAMPLES as u16
                && header.profile_id == *session.profile_id.as_bytes()
                && header.endpoint_id == *session.endpoint_id.as_bytes()
                && header.channel_id == session.channel_id.0
                && header.epoch == session.epoch
        });
        if accepted {
            let Some(samples) = decode_pcm(frame) else {
                self.reject_frame();
                return;
            };
            if !samples.iter().all(|sample| sample.is_finite()) {
                self.reject_frame();
                return;
            }
            {
                let sessions = self.sessions.lock();
                if !sessions.contains_key(&session_id) {
                    return;
                }
                let endpoint = MixEndpoint {
                    endpoint_id: session.endpoint_id,
                    channel_id: session.channel_id,
                };
                let mut mixer = self.mixer.lock();
                let before = mixer.dropped_frames;
                if !mixer.enqueue(endpoint, samples) {
                    return;
                }
                if mixer.dropped_frames > before {
                    write_diagnostic_event("audio_input_overflow");
                }
            }
            let accepted_frames = {
                let mut metrics = self.metrics.lock();
                metrics.accepted_audio_frames += 1;
                metrics.accepted_audio_frames
            };
            if accepted_frames == 1 || accepted_frames % 500 == 0 {
                write_diagnostic_event("audio_frames_accepted");
            }
        } else {
            self.reject_frame();
        }
    }

    fn reject_frame(&self) {
        let rejected_frames = {
            let mut metrics = self.metrics.lock();
            metrics.rejected_audio_frames += 1;
            metrics.rejected_audio_frames
        };
        if rejected_frames == 1 || rejected_frames % 100 == 0 {
            write_diagnostic_event("audio_frame_rejected");
        }
        warn!("rejected malformed or unauthorized audio frame");
    }
}

fn diagnostic_log_path() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Library/Logs/Meet Bridge Hub/hub-audio.ndjson")
}

fn write_diagnostic_event(event: &str) {
    let path = diagnostic_log_path();
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(
        file,
        r#"{{"timestamp_ms":{},"event":"{}"}}"#,
        unix_millis(SystemTime::now()),
        event
    );
}

fn unix_millis(value: SystemTime) -> u128 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn make_confirmation_code() -> Result<String, AdmissionError> {
    let mut bytes = [0_u8; 4];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| AdmissionError::RandomUnavailable)?;
    Ok(format!("{:06}", u32::from_le_bytes(bytes) % 1_000_000))
}

fn protocol_is_compatible(range: ProtocolRange) -> bool {
    let current = ProtocolVersion::CURRENT;
    range.minimum.major <= current.major
        && current.major <= range.maximum.major
        && range.minimum.minor <= current.minor
        && current.minor <= range.maximum.minor
}

fn microphone_matrix() -> ClockedMixer {
    let mut matrix = ClockedMixer::default();
    for channel_id in [
        ChannelId::CHANNEL_1,
        ChannelId::CHANNEL_2,
        ChannelId::CHANNEL_3,
    ] {
        let _ = matrix.register(MixEndpoint {
            endpoint_id: Uuid::nil(),
            channel_id,
        });
    }
    matrix
}

fn decode_pcm(frame: &[u8]) -> Option<[f32; PCM_FRAME_SAMPLES]> {
    let payload = frame.get(usize::from(AUDIO_HEADER_LENGTH)..)?;
    if payload.len() != MAX_AUDIO_PAYLOAD_BYTES {
        return None;
    }
    let mut samples = [0.0_f32; PCM_FRAME_SAMPLES];
    for (sample, bytes) in samples.iter_mut().zip(payload.chunks_exact(4)) {
        *sample = f32::from_le_bytes(bytes.try_into().ok()?);
    }
    Some(samples)
}

fn encode_downlink_frame(
    session: &SessionRecord,
    samples: [f32; PCM_FRAME_SAMPLES],
    sequence: u64,
) -> Vec<u8> {
    let header = AudioFrameHeader {
        magic: shared_proto::AUDIO_MAGIC,
        header_length: AUDIO_HEADER_LENGTH,
        protocol_version: 1,
        channel_id: session.channel_id.0,
        flags: shared_proto::audio_flags::DOWNLINK_REMOTE_BUS,
        samples_per_channel: PCM_FRAME_SAMPLES as u16,
        profile_id: *session.profile_id.as_bytes(),
        endpoint_id: *session.endpoint_id.as_bytes(),
        epoch: session.epoch,
        sequence,
        payload_length: MAX_AUDIO_PAYLOAD_BYTES as u32,
    };
    let mut frame = Vec::with_capacity(usize::from(AUDIO_HEADER_LENGTH) + MAX_AUDIO_PAYLOAD_BYTES);
    frame.extend_from_slice(&header.to_bytes());
    for sample in samples {
        frame.extend_from_slice(&sample.to_le_bytes());
    }
    frame
}

fn make_secret() -> Result<String, AdmissionError> {
    let mut bytes = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| AdmissionError::RandomUnavailable)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

#[derive(Debug, Deserialize)]
struct AudioAuth {
    session_id: String,
    session_secret_b64: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AdmissionError {
    #[error("invalid channel")]
    InvalidChannel,
    #[error("session capacity reached")]
    CapacityReached,
    #[error("secure random source unavailable")]
    RandomUnavailable,
}

#[derive(Debug, thiserror::Error)]
enum ConnectionError {
    #[error("audio transport setup failed")]
    Transport(std::io::Error),
    #[error("websocket error: {0}")]
    WebSocket(tokio_tungstenite::tungstenite::Error),
    #[error("audio authentication is required")]
    AuthenticationRequired,
    #[error("invalid authentication payload: {0}")]
    AuthenticationPayload(serde_json::Error),
    #[error("audio authentication rejected")]
    RejectedAuthentication,
}
