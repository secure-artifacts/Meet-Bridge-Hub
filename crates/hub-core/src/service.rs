use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, OnceLock, mpsc as std_mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
use tokio::sync::Notify;
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
const MIX_FRAME_DURATION: Duration = Duration::from_millis(10);
const MAX_MIX_CATCH_UP_TICKS: u64 = 3;

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

struct AudioClient {
    sender: Arc<DownlinkQueue>,
    exclude_same_profile: bool,
    include_hub_microphone: bool,
}

impl AudioClient {
    fn send(&self, frame: Vec<u8>) -> usize {
        self.sender.push(frame)
    }
}

const MAX_DOWNLINK_FRAMES: usize = 32;
const MAX_DOWNLINK_AGE: Duration = Duration::from_millis(250);

struct QueuedDownlink {
    frame: Vec<u8>,
    enqueued_at: Instant,
}

#[derive(Default)]
struct DownlinkState {
    frames: VecDeque<QueuedDownlink>,
    closed: bool,
}

#[derive(Default)]
struct DownlinkQueue {
    state: Mutex<DownlinkState>,
    notify: Notify,
}

impl DownlinkQueue {
    fn push(&self, frame: Vec<u8>) -> usize {
        self.push_at(frame, Instant::now())
    }

    fn push_at(&self, frame: Vec<u8>, enqueued_at: Instant) -> usize {
        let now = Instant::now();
        let mut state = self.state.lock();
        if state.closed {
            return 0;
        }
        let mut dropped = 0;
        while state.frames.front().is_some_and(|queued| {
            now.saturating_duration_since(queued.enqueued_at) > MAX_DOWNLINK_AGE
        }) {
            state.frames.pop_front();
            dropped += 1;
        }
        while state.frames.len() >= MAX_DOWNLINK_FRAMES {
            state.frames.pop_front();
            dropped += 1;
        }
        state
            .frames
            .push_back(QueuedDownlink { frame, enqueued_at });
        drop(state);
        self.notify.notify_one();
        dropped
    }

    async fn recv(&self) -> Option<Vec<u8>> {
        loop {
            let notified = self.notify.notified();
            {
                let now = Instant::now();
                let mut state = self.state.lock();
                while state.frames.front().is_some_and(|queued| {
                    now.saturating_duration_since(queued.enqueued_at) > MAX_DOWNLINK_AGE
                }) {
                    state.frames.pop_front();
                }
                if let Some(queued) = state.frames.pop_front() {
                    return Some(queued.frame);
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    fn close(&self) {
        let mut state = self.state.lock();
        state.closed = true;
        state.frames.clear();
        drop(state);
        self.notify.notify_waiters();
    }
}

#[derive(Clone)]
pub struct HubService {
    config: HubConfig,
    sessions: Arc<Mutex<HashMap<SessionId, SessionRecord>>>,
    mixer: Arc<Mutex<ClockedMixer>>,
    audio_clients: Arc<Mutex<HashMap<SessionId, AudioClient>>>,
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
        if endpoint_id.is_nil()
            || sessions
                .values()
                .any(|s| s.endpoint_id == endpoint_id && s.profile_id != profile_id)
        {
            return Err(AdmissionError::EndpointConflict);
        }
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
                if let Some(client) = self.audio_clients.lock().remove(&id) {
                    client.sender.close();
                }
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
            if let Some(client) = self.audio_clients.lock().remove(&session_id) {
                client.sender.close();
            }
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
        let mut clock = interval(MIX_FRAME_DURATION);
        // Windows commonly wakes a nominal 10 ms timer every 15.6 ms. The
        // monotonic deadline below restores the missing one or two frames while
        // this interval merely provides wakeups. Long stalls are not replayed.
        clock.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut next_mix_deadline = Instant::now();
        let mut sequence = 0_u64;
        loop {
            let (stream, peer_addr) = tokio::select! {
                accepted = listener.accept() => accepted?,
                _ = clock.tick() => {
                    let now = Instant::now();
                    let due_ticks = due_mix_ticks(now, next_mix_deadline);
                    if due_ticks == 0 {
                        continue;
                    }
                    if due_ticks > MAX_MIX_CATCH_UP_TICKS {
                        // Preserve real-time latency after a genuine process
                        // stall. Sequence gaps make the skipped time visible.
                        sequence = sequence.wrapping_add(due_ticks - 1);
                        self.mix_tick(sequence);
                        sequence = sequence.wrapping_add(1);
                        next_mix_deadline = now + MIX_FRAME_DURATION;
                    } else {
                        for _ in 0..due_ticks {
                            self.mix_tick(sequence);
                            sequence = sequence.wrapping_add(1);
                        }
                        next_mix_deadline += MIX_FRAME_DURATION * due_ticks as u32;
                    }
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
        let (underrun, levels, backpressure) = {
            let sessions = self.sessions.lock();
            let clients = self.audio_clients.lock();
            let mut mixer = self.mixer.lock();
            let before = mixer.underruns;
            let mut levels = Vec::new();
            let mut backpressure = Vec::new();
            mixer.advance();
            for (id, client) in clients.iter() {
                let Some(session) = sessions.get(id) else {
                    continue;
                };
                let endpoint = MixEndpoint {
                    endpoint_id: session.endpoint_id,
                    channel_id: session.channel_id,
                };
                let mut excluded: Vec<_> = sessions
                    .values()
                    .filter(|source| {
                        client.exclude_same_profile && source.profile_id == session.profile_id
                    })
                    .map(|source| MixEndpoint {
                        endpoint_id: source.endpoint_id,
                        channel_id: source.channel_id,
                    })
                    .collect();
                if !client.include_hub_microphone {
                    excluded.push(MixEndpoint {
                        endpoint_id: Uuid::nil(),
                        channel_id: session.channel_id,
                    });
                }
                let samples = mixer.mix_for_excluding(endpoint, &excluded);
                if sequence % 100 == 0 {
                    levels.push((*id, session.clone(), samples));
                }
                let frame = encode_downlink_frame(session, samples, sequence);
                // Preserve every frame while the receiver keeps pace. If it
                // stalls, discard only frames older than the real-time budget.
                let dropped = client.send(frame);
                if dropped > 0 {
                    backpressure.push((*id, session.clone(), dropped));
                }
            }
            (mixer.underruns > before, levels, backpressure)
        };
        for (session_id, session, samples) in levels {
            write_audio_level(
                "audio_downlink_mix",
                session_id,
                &session,
                sequence,
                &samples,
            );
        }
        for (session_id, session, dropped) in backpressure {
            write_diagnostic_json(serde_json::json!({
                "timestamp_ms": unix_millis(SystemTime::now()),
                "event": "audio_output_backpressure",
                "sessionId": session_id,
                "profileId": session.profile_id,
                "endpointId": session.endpoint_id,
                "channelId": session.channel_id.0,
                "sequence": sequence,
                "droppedFrames": dropped,
            }));
        }
        if underrun {
            write_diagnostic_event("audio_input_underrun");
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
        let downlinks = Arc::new(DownlinkQueue::default());
        let sender = downlinks.clone();
        {
            let sessions = self.sessions.lock();
            let mut clients = self.audio_clients.lock();
            if !sessions.contains_key(&session_id) || clients.contains_key(&session_id) {
                return Err(ConnectionError::RejectedAuthentication);
            }
            clients.insert(
                session_id,
                AudioClient {
                    sender,
                    exclude_same_profile: auth.exclude_same_profile,
                    include_hub_microphone: auth.include_hub_microphone,
                },
            );
        }
        self.metrics.lock().authenticated_audio_connections += 1;
        write_diagnostic_event("audio_authenticated");

        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "AUDIO_READY",
                    "exclude_same_profile": auth.exclude_same_profile,
                    "include_hub_microphone": auth.include_hub_microphone,
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(ConnectionError::WebSocket)?;
        let (mut socket_writer, mut socket_reader) = socket.split();
        let reader = async {
            while let Some(message) = socket_reader.next().await {
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
                    // tungstenite queues a matching Pong while reading. The
                    // independent audio writer continuously flushes the sink.
                    Message::Ping(_) | Message::Pong(_) => {}
                    _ => self.reject_frame(),
                }
            }
            Ok(())
        };
        let writer = async {
            let mut previous_downlink_sequence: Option<u64> = None;
            while let Some(output) = downlinks.recv().await {
                if !self.sessions.lock().contains_key(&session_id) {
                    break;
                }
                if let Ok(header) = AudioFrameHeader::from_bytes(&output) {
                    if let Some(previous) = previous_downlink_sequence {
                        let expected = previous.wrapping_add(1);
                        if header.sequence != expected {
                            write_downlink_gap(session_id, &session, previous, header.sequence);
                        }
                    }
                    previous_downlink_sequence = Some(header.sequence);
                }
                match timeout(
                    MAX_DOWNLINK_AGE,
                    socket_writer.send(Message::Binary(output.into())),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => return Err(ConnectionError::WebSocket(error)),
                    Err(_) => {
                        self.metrics.lock().audio_slow_disconnects += 1;
                        write_diagnostic_event("audio_output_send_timeout");
                        break;
                    }
                }
            }
            Ok(())
        };
        tokio::pin!(reader);
        tokio::pin!(writer);
        let result = tokio::select! {
            result = &mut reader => result,
            result = &mut writer => result,
        };
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
                && header.protocol_version == 1
                && header.flags & shared_proto::audio_flags::UPLINK_PROFILE_BUS != 0
                && header.flags & shared_proto::audio_flags::DOWNLINK_REMOTE_BUS == 0
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
            let overflowed = {
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
                mixer.dropped_frames > before
            };
            if overflowed {
                write_diagnostic_event("audio_input_overflow");
            }
            let accepted_frames = {
                let mut metrics = self.metrics.lock();
                metrics.accepted_audio_frames += 1;
                metrics.accepted_audio_frames
            };
            if accepted_frames == 1 || accepted_frames % 500 == 0 {
                write_diagnostic_event("audio_frames_accepted");
            }
            if let Some(header) = header {
                if header.sequence % 100 == 0 {
                    write_audio_level(
                        "audio_uplink_pcm",
                        session_id,
                        session,
                        header.sequence,
                        &samples,
                    );
                }
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

fn due_mix_ticks(now: Instant, next_deadline: Instant) -> u64 {
    if now < next_deadline {
        return 0;
    }
    let overdue = now.saturating_duration_since(next_deadline).as_nanos();
    1_u64.saturating_add(u64::try_from(overdue / MIX_FRAME_DURATION.as_nanos()).unwrap_or(u64::MAX))
}

fn diagnostic_log_path() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("MEET_BRIDGE_AUDIO_LOG") {
        return std::path::PathBuf::from(path);
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return std::path::PathBuf::from(local_app_data)
            .join("Meet Bridge Hub")
            .join("Logs")
            .join("hub-audio.ndjson");
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return std::path::PathBuf::from(home)
            .join("Library")
            .join("Logs")
            .join("Meet Bridge Hub")
            .join("hub-audio.ndjson");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(state_home) = std::env::var_os("XDG_STATE_HOME") {
        return std::path::PathBuf::from(state_home)
            .join("meet-bridge-hub")
            .join("hub-audio.ndjson");
    }
    std::env::temp_dir()
        .join("Meet Bridge Hub")
        .join("Logs")
        .join("hub-audio.ndjson")
}

fn write_diagnostic_event(event: &str) {
    write_diagnostic_json(serde_json::json!({
        "timestamp_ms": unix_millis(SystemTime::now()),
        "event": event,
    }));
}

fn write_audio_level(
    event: &str,
    session_id: SessionId,
    session: &SessionRecord,
    sequence: u64,
    samples: &[f32],
) {
    let energy: f64 = samples.iter().map(|s| f64::from(*s).powi(2)).sum();
    let peak = samples.iter().fold(0.0_f32, |peak, s| peak.max(s.abs()));
    write_diagnostic_json(serde_json::json!({
        "timestamp_ms": unix_millis(SystemTime::now()), "event": event,
        "sessionId": session_id, "profileId": session.profile_id, "endpointId": session.endpoint_id,
        "channelId": session.channel_id.0, "sequence": sequence, "frames": samples.len(),
        "sampleRate": 48000, "rms": (energy / samples.len() as f64).sqrt(), "peak": peak,
    }));
}

fn write_downlink_gap(
    session_id: SessionId,
    session: &SessionRecord,
    previous_sequence: u64,
    sequence: u64,
) {
    write_diagnostic_json(serde_json::json!({
        "timestamp_ms": unix_millis(SystemTime::now()),
        "event": "audio_output_coalesced",
        "sessionId": session_id,
        "profileId": session.profile_id,
        "endpointId": session.endpoint_id,
        "channelId": session.channel_id.0,
        "previousSequence": previous_sequence,
        "sequence": sequence,
        "skippedFrames": sequence.wrapping_sub(previous_sequence).saturating_sub(1),
    }));
}

fn write_diagnostic_json(value: serde_json::Value) {
    let mut line = value.to_string();
    line.push('\n');
    let _ = diagnostic_log_sender().try_send(line);
}

fn diagnostic_log_sender() -> &'static std_mpsc::SyncSender<String> {
    static SENDER: OnceLock<std_mpsc::SyncSender<String>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (sender, receiver) = std_mpsc::sync_channel::<String>(4096);
        let path = diagnostic_log_path();
        let _ = std::thread::Builder::new()
            .name("meet-bridge-diagnostic-log".to_owned())
            .spawn(move || {
                let Some(parent) = path.parent() else {
                    return;
                };
                if fs::create_dir_all(parent).is_err() {
                    return;
                }
                let Ok(file) = OpenOptions::new().create(true).append(true).open(path) else {
                    return;
                };
                let mut writer = BufWriter::new(file);
                while let Ok(line) = receiver.recv() {
                    if writer.write_all(line.as_bytes()).is_err() {
                        return;
                    }
                    for pending in receiver.try_iter() {
                        if writer.write_all(pending.as_bytes()).is_err() {
                            return;
                        }
                    }
                    let _ = writer.flush();
                }
            });
        sender
    })
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
        matrix.register(MixEndpoint {
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
    let (chunks, remainder) = payload.as_chunks::<4>();
    if !remainder.is_empty() {
        return None;
    }
    for (sample, bytes) in samples.iter_mut().zip(chunks) {
        *sample = f32::from_le_bytes(*bytes);
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
    #[serde(default)]
    exclude_same_profile: bool,
    #[serde(default)]
    include_hub_microphone: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum AdmissionError {
    #[error("endpoint identity is reserved or already belongs to another profile")]
    EndpointConflict,
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

#[cfg(test)]
mod downlink_tests {
    use super::*;

    #[test]
    fn coarse_windows_wakeups_restore_100_hz_without_unbounded_replay() {
        let start = Instant::now();
        let mut next = start;
        let mut rendered = 0_u64;
        for wake_ms in [0_u64, 16, 31, 47, 62, 78, 94] {
            let now = start + Duration::from_millis(wake_ms);
            let due = due_mix_ticks(now, next);
            assert!(due <= MAX_MIX_CATCH_UP_TICKS);
            rendered += due;
            next += MIX_FRAME_DURATION * due as u32;
        }
        assert_eq!(rendered, 10, "94 ms must render the deadlines at 0..90 ms");

        assert!(
            due_mix_ticks(start + Duration::from_secs(1), next) > MAX_MIX_CATCH_UP_TICKS,
            "a genuine stall must take the skip path instead of replaying one second"
        );
    }

    #[tokio::test]
    async fn receiver_that_keeps_pace_gets_every_frame_in_order() {
        let queue = DownlinkQueue::default();
        for sequence in 0_u8..12 {
            assert_eq!(queue.push(vec![sequence]), 0);
        }
        for expected in 0_u8..12 {
            assert_eq!(queue.recv().await, Some(vec![expected]));
        }
    }

    #[tokio::test]
    async fn stalled_receiver_discards_only_expired_audio_then_recovers() {
        let queue = DownlinkQueue::default();
        let stale = Instant::now() - MAX_DOWNLINK_AGE - Duration::from_millis(1);
        assert_eq!(queue.push_at(vec![1], stale), 0);
        assert_eq!(queue.push(vec![2]), 1);
        assert_eq!(queue.push(vec![3]), 0);
        assert_eq!(queue.recv().await, Some(vec![2]));
        assert_eq!(queue.recv().await, Some(vec![3]));
        assert_eq!(queue.push(vec![4]), 0);
        assert_eq!(queue.recv().await, Some(vec![4]));
    }

    #[tokio::test]
    async fn short_pause_preserves_fresh_audio() {
        let queue = DownlinkQueue::default();
        for sequence in 0_u8..20 {
            assert_eq!(queue.push(vec![sequence]), 0);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        for expected in 0_u8..20 {
            assert_eq!(queue.recv().await, Some(vec![expected]));
        }
    }

    #[tokio::test]
    async fn one_stalled_profile_does_not_drop_a_healthy_profiles_frames() {
        let stalled = DownlinkQueue::default();
        let healthy = DownlinkQueue::default();
        for sequence in 0_u8..100 {
            let _ = stalled.push(vec![sequence]);
            assert_eq!(healthy.push(vec![sequence]), 0);
            assert_eq!(healthy.recv().await, Some(vec![sequence]));
        }
        assert_eq!(stalled.state.lock().frames.len(), MAX_DOWNLINK_FRAMES);
        assert!(stalled.push(vec![100]) > 0);
        assert_eq!(stalled.recv().await, Some(vec![69]));
        assert_eq!(healthy.push(vec![100]), 0);
        assert_eq!(healthy.recv().await, Some(vec![100]));
    }

    #[tokio::test]
    async fn closing_queue_wakes_a_waiting_writer() {
        let queue = Arc::new(DownlinkQueue::default());
        let waiting = {
            let queue = queue.clone();
            tokio::spawn(async move { queue.recv().await })
        };
        tokio::task::yield_now().await;
        queue.close();
        assert_eq!(
            timeout(Duration::from_millis(100), waiting)
                .await
                .expect("waiting writer should wake")
                .expect("waiting task should finish"),
            None
        );
    }
}
