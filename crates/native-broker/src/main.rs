use std::io::{stdin, stdout};

use meet_bridge_native_broker::{read_message, write_message};
use shared_proto::{NativeRequest, NativeResponse, ProtocolError};

#[tokio::main]
async fn main() {
    let mut input = stdin().lock();
    let mut output = stdout().lock();

    let broker_instance_id = uuid::Uuid::new_v4();
    while let Ok(request) = read_message::<NativeRequest>(&mut input) {
        let profile_id = request_profile_id(&request);
        let response = match meet_bridge_native_broker::core_client::forward_control(
            broker_instance_id,
            profile_id,
            request,
        )
        .await
        {
            Ok(response) => response,
            Err(_) => NativeResponse::Error(ProtocolError {
                request_id: None,
                code: "hub_unavailable".to_owned(),
                action_required: Some("Start Meet Bridge Hub, then retry.".to_owned()),
            }),
        };
        if write_message(&mut output, &response).is_err() {
            break;
        }
    }
}

fn request_profile_id(request: &NativeRequest) -> uuid::Uuid {
    match request {
        NativeRequest::Hello(message) => message.profile_id,
        NativeRequest::PairRequest(message) => message.profile_id,
        NativeRequest::PairDecision(message) => message.profile_id,
        NativeRequest::SessionRequest(message) => message.profile_id,
    }
}
