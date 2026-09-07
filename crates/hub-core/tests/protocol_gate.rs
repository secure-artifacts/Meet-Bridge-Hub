#![allow(clippy::unwrap_used, clippy::expect_used)]

use meet_bridge_hub_core::{HubConfig, HubService};
use shared_proto::{
    BrokerCoreMessage, ControlRequest, Hello, NativeRequest, NativeResponse, ProtocolRange,
    ProtocolVersion,
};
use uuid::Uuid;

#[test]
fn incompatible_hello_cannot_create_a_pairing_challenge() {
    let hub = HubService::new(HubConfig::default());
    let profile_id = Uuid::new_v4();
    let request_id = Uuid::new_v4();
    let response = hub.handle_control(
        ControlRequest {
            broker_instance_id: Uuid::new_v4(),
            profile_id,
            message: NativeRequest::Hello(Hello {
                request_id,
                profile_id,
                profile_public_key_b64: String::new(),
                extension_version: "legacy".to_owned(),
                protocol: ProtocolRange {
                    minimum: ProtocolVersion { major: 2, minor: 0 },
                    maximum: ProtocolVersion { major: 2, minor: 0 },
                },
                client_nonce_b64: String::new(),
                capabilities: Vec::new(),
            }),
        },
        Uuid::new_v4(),
    );
    let BrokerCoreMessage::ControlResponse(response) = response else {
        panic!("expected a control response");
    };
    let NativeResponse::Error(error) = response.message else {
        panic!("incompatible protocol must not receive a pairing challenge");
    };
    assert_eq!(error.code, "protocol_incompatible");
    assert_eq!(error.request_id, Some(request_id));
}
