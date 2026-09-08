#![cfg(unix)]

use meet_bridge_hub_core::{
    HubConfig, HubService,
    control_socket::{prepare_control_socket_directory, serve_control_endpoint},
};
use shared_proto::{BrokerCoreMessage, HealthPing, HealthPong};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

#[tokio::test]
async fn broker_health_ping_receives_core_identity() {
    let path = std::env::temp_dir().join(format!("mbh-{}.sock", &Uuid::new_v4().to_string()[..8]));
    prepare_control_socket_directory(&path).unwrap();
    let core_id = Uuid::new_v4();
    let server = tokio::spawn(serve_control_endpoint(
        path.clone(),
        core_id,
        HubService::new(HubConfig::default()),
    ));
    tokio::time::sleep(Duration::from_millis(20)).await;
    if server.is_finished() {
        panic!("control socket server failed to start: {:?}", server.await);
    }
    let mut stream = tokio::time::timeout(
        Duration::from_secs(1),
        tokio::net::UnixStream::connect(&path),
    )
    .await
    .expect("control socket connect timed out")
    .expect("control socket connect failed");
    let message = BrokerCoreMessage::HealthPing(HealthPing {
        request_id: Uuid::new_v4(),
    });
    let payload = serde_json::to_vec(&message).unwrap();
    stream.write_u32_le(payload.len() as u32).await.unwrap();
    stream.write_all(&payload).await.unwrap();
    let size = stream.read_u32_le().await.unwrap();
    let mut bytes = vec![0_u8; size as usize];
    stream.read_exact(&mut bytes).await.unwrap();
    let response: BrokerCoreMessage = serde_json::from_slice(&bytes).unwrap();
    let BrokerCoreMessage::HealthPong(HealthPong {
        core_instance_id, ..
    }) = response
    else {
        panic!("expected health pong");
    };
    assert_eq!(core_instance_id, core_id);
    server.abort();
    std::fs::remove_file(path).ok();
}
