use crate::ids::{ChannelId, DecimalU64, EndpointId, ProfileId, RequestId, SessionId};
use crate::version::ProtocolRange;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::ZeroizeOnDrop;

#[derive(Serialize, Deserialize, ZeroizeOnDrop, Debug)]
#[serde(transparent)]
pub struct SensitiveBase64(pub String);

#[derive(Serialize, Deserialize, Debug)]
pub struct Hello {
    pub request_id: RequestId,
    pub profile_id: ProfileId,
    pub profile_public_key_b64: String,
    pub extension_version: String,
    pub protocol: ProtocolRange,
    pub client_nonce_b64: String,
    pub capabilities: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PairRequest {
    pub request_id: RequestId,
    pub profile_id: ProfileId,
    pub profile_public_key_b64: String,
    pub client_nonce_b64: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PairChallenge {
    pub request_id: RequestId,
    pub hub_instance_id: Uuid,
    pub hub_public_key_b64: String,
    pub confirmation_code: String,
    pub expires_at_unix_ms: DecimalU64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PairDecision {
    pub request_id: RequestId,
    pub profile_id: ProfileId,
    pub approved: bool,
    pub confirmation_code: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PairResult {
    pub request_id: RequestId,
    pub profile_id: ProfileId,
    pub paired: bool,
    pub anonymous_alias: String,
    pub hub_signature_b64: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SessionRequest {
    pub request_id: RequestId,
    pub profile_id: ProfileId,
    pub endpoint_id: EndpointId,
    pub channel_id: ChannelId,
    pub protocol: ProtocolRange,
    pub client_nonce_b64: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AudioFormatContract {
    pub sample_rate: u32,
    pub channels: u8,
    pub sample_format: String,
    pub frame_samples: u16,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LoopbackEndpoint {
    pub host: String,
    pub port: u16,
    pub path: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SessionGrant {
    pub request_id: RequestId,
    pub session_id: SessionId,
    pub profile_id: ProfileId,
    pub endpoint_id: EndpointId,
    pub channel_id: ChannelId,
    pub epoch: DecimalU64,
    pub endpoint: LoopbackEndpoint,
    pub ticket_id_b64: String,
    pub session_secret_b64: SensitiveBase64,
    pub expires_at_unix_ms: DecimalU64,
    pub audio: AudioFormatContract,
    pub feature_bits: DecimalU64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ProtocolError {
    pub request_id: Option<RequestId>,
    pub code: String,
    pub action_required: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", content = "payload")]
pub enum NativeRequest {
    Hello(Hello),
    PairRequest(PairRequest),
    PairDecision(PairDecision),
    SessionRequest(SessionRequest),
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", content = "payload")]
pub enum NativeResponse {
    PairChallenge(PairChallenge),
    PairResult(PairResult),
    SessionGrant(SessionGrant),
    Error(ProtocolError),
}
