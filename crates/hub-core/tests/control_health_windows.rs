#![cfg(windows)]
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::time::Duration;

use meet_bridge_hub_core::{
    HubConfig, HubService,
    control_socket::{CONTROL_PIPE_NAME, serve_control_pipe_at},
};
use shared_proto::{BrokerCoreMessage, HealthPing, HealthPong};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

#[tokio::test]
async fn named_pipe_health_ping_receives_core_identity() {
    let core_id = Uuid::new_v4();
    let pipe_name = format!("{CONTROL_PIPE_NAME}-test-{core_id}");
    let server = tokio::spawn(serve_control_pipe_at(
        pipe_name.clone(),
        core_id,
        HubService::new(HubConfig::default()),
    ));
    let mut stream = None;
    for _ in 0..40 {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(&pipe_name) {
            Ok(client) => {
                stream = Some(client);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(error) => panic!("named pipe connect failed: {error}"),
        }
    }
    let mut stream = stream.expect("named pipe was not ready within one second");
    let request_id = Uuid::new_v4();
    let payload =
        serde_json::to_vec(&BrokerCoreMessage::HealthPing(HealthPing { request_id })).unwrap();
    stream.write_u32_le(payload.len() as u32).await.unwrap();
    stream.write_all(&payload).await.unwrap();
    let size = stream.read_u32_le().await.unwrap();
    let mut bytes = vec![0_u8; size as usize];
    stream.read_exact(&mut bytes).await.unwrap();
    let response: BrokerCoreMessage = serde_json::from_slice(&bytes).unwrap();
    let BrokerCoreMessage::HealthPong(HealthPong {
        request_id: response_id,
        core_instance_id,
        ..
    }) = response
    else {
        panic!("expected health pong");
    };
    assert_eq!(response_id, request_id);
    assert_eq!(core_instance_id, core_id);
    server.abort();
}
