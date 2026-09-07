#![allow(clippy::unwrap_used, clippy::expect_used)]

use futures_util::{SinkExt, StreamExt};
use meet_bridge_hub_core::{HubConfig, HubService, PCM_FRAME_SAMPLES};
use shared_proto::{AUDIO_HEADER_LENGTH, AUDIO_MAGIC, AudioFrameHeader, ChannelId, audio_flags};
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

fn uplink(
    profile_id: Uuid,
    endpoint_id: Uuid,
    channel_id: ChannelId,
    epoch: u64,
    value: f32,
) -> Vec<u8> {
    let header = AudioFrameHeader {
        magic: AUDIO_MAGIC,
        header_length: AUDIO_HEADER_LENGTH,
        protocol_version: 1,
        channel_id: channel_id.0,
        flags: audio_flags::UPLINK_PROFILE_BUS,
        samples_per_channel: PCM_FRAME_SAMPLES as u16,
        profile_id: *profile_id.as_bytes(),
        endpoint_id: *endpoint_id.as_bytes(),
        epoch,
        sequence: 1,
        payload_length: (PCM_FRAME_SAMPLES * 4) as u32,
    };
    let mut bytes = header.to_bytes().to_vec();
    for _ in 0..PCM_FRAME_SAMPLES {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[tokio::test]
async fn two_authenticated_endpoints_receive_n_minus_one_downlinks() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hub = HubService::new(HubConfig::default());
    let profile_a = Uuid::new_v4();
    let endpoint_a = Uuid::new_v4();
    let profile_b = Uuid::new_v4();
    let endpoint_b = Uuid::new_v4();
    let admission_a = hub
        .admit_session(profile_a, endpoint_a, ChannelId::CHANNEL_1, 1)
        .unwrap();
    let admission_b = hub
        .admit_session(profile_b, endpoint_b, ChannelId::CHANNEL_1, 1)
        .unwrap();
    let server = tokio::spawn(hub.clone().serve_listener(listener));

    let (mut socket_a, _) = connect_async(format!("ws://{address}/audio"))
        .await
        .unwrap();
    socket_a
        .send(Message::Text(
            serde_json::json!({
                "session_id": admission_a.session_id,
                "session_secret_b64": admission_a.session_secret_b64,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(socket_a.next().await, Some(Ok(Message::Text(_)))));

    let (mut socket_b, _) = connect_async(format!("ws://{address}/audio"))
        .await
        .unwrap();
    socket_b
        .send(Message::Text(
            serde_json::json!({
                "session_id": admission_b.session_id,
                "session_secret_b64": admission_b.session_secret_b64,
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    assert!(matches!(socket_b.next().await, Some(Ok(Message::Text(_)))));

    socket_b
        .send(Message::Binary(
            uplink(profile_b, endpoint_b, ChannelId::CHANNEL_1, 1, 0.25).into(),
        ))
        .await
        .unwrap();
    let _ = socket_b.next().await;
    socket_a
        .send(Message::Binary(
            uplink(profile_a, endpoint_a, ChannelId::CHANNEL_1, 1, 0.75).into(),
        ))
        .await
        .unwrap();
    let Some(Ok(Message::Binary(response))) = socket_a.next().await else {
        panic!("expected downlink");
    };
    let header = AudioFrameHeader::from_bytes(&response).unwrap();
    assert_eq!(header.flags, audio_flags::DOWNLINK_REMOTE_BUS);
    assert_eq!(
        f32::from_le_bytes(response[64..68].try_into().unwrap()),
        0.25
    );
    socket_a.close(None).await.unwrap();
    socket_b.close(None).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    assert_eq!(
        hub.status().active_sessions,
        0,
        "closed audio sockets must release mixer sessions"
    );
    server.abort();
}
