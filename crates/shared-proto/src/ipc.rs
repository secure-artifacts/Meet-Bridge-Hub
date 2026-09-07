use crate::control::{NativeRequest, NativeResponse};
use crate::ids::{DecimalU64, ProfileId, RequestId};
use crate::version::ProtocolRange;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug)]
pub struct BrokerRegister {
    pub broker_instance_id: Uuid,
    pub broker_pid: u32,
    pub observed_extension_origin: String,
    pub broker_nonce_b64: String,
    pub broker_proof_b64: String,
    pub protocol: ProtocolRange,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ControlRequest {
    pub broker_instance_id: Uuid,
    pub profile_id: ProfileId,
    pub message: NativeRequest,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ControlResponse {
    pub broker_instance_id: Uuid,
    pub profile_id: ProfileId,
    pub message: NativeResponse,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HealthPing {
    pub request_id: RequestId,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HealthPong {
    pub request_id: RequestId,
    pub core_instance_id: Uuid,
    pub core_epoch: DecimalU64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "kind", content = "payload")]
pub enum BrokerCoreMessage {
    BrokerRegister(BrokerRegister),
    ControlRequest(ControlRequest),
    ControlResponse(ControlResponse),
    HealthPing(HealthPing),
    HealthPong(HealthPong),
}
