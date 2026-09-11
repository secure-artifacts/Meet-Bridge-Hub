#![allow(clippy::chunks_exact_to_as_chunks, clippy::unwrap_used)]

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn three_seconds_of_real_windows_bursts_preserve_every_sample() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hub = HubService::new(HubConfig::default());
    let source = hub
        .admit_session(Uuid::new_v4(), Uuid::new_v4(), ChannelId::CHANNEL_1, 1)
        .unwrap();
    let target = hub
        .admit_session(Uuid::new_v4(), Uuid::new_v4(), ChannelId::CHANNEL_1, 1)
        .unwrap();
    let server = tokio::spawn(hub.clone().serve_listener(listener));
    let (mut source_socket, _) = connect_async(format!("ws://{address}/audio"))
        .await
        .unwrap();
    let (mut target_socket, _) = connect_async(format!("ws://{address}/audio"))
        .await
        .unwrap();
    for (socket, admission) in [(&mut source_socket, &source), (&mut target_socket, &target)] {
        socket.send(Message::Text(serde_json::json!({"session_id": admission.session_id, "session_secret_b64": admission.session_secret_b64}).to_string().into())).await.unwrap();
        assert!(matches!(socket.next().await, Some(Ok(Message::Text(_)))));
    }
    let (mut writer, mut reader) = source_socket.split();
    let drain = tokio::spawn(async move { while reader.next().await.is_some() {} });
    let producer = tokio::spawn(async move {
        let mut clock = tokio::time::interval(std::time::Duration::from_millis(30));
        // A real-time source does not replay every timer deadline after the
        // machine is descheduled. Catch-up bursts are stale audio and conflict
        // with the Hub's deliberate 250 ms latency ceiling.
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        for i in 1..=300 {
            // Six-frame prebuffer, followed by three-frame arrival bursts.
            if i == 7 {
                clock.tick().await;
            }
            if i >= 7 && (i - 7) % 3 == 0 {
                clock.tick().await;
            }
            writer
                .send(Message::Binary(
                    uplink(
                        source.profile_id,
                        source.endpoint_id,
                        ChannelId::CHANNEL_1,
                        1,
                        i as f32 / 1000.0,
                    )
                    .into(),
                ))
                .await
                .unwrap();
        }
        writer
    });
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut received = 0;
        while received < 300 {
            let Some(Ok(Message::Binary(frame))) = target_socket.next().await else {
                panic!("missing PCM")
            };
            if received == 0 && frame[64..].iter().all(|byte| *byte == 0) {
                continue;
            }
            received += 1;
            for bytes in frame[64..].chunks_exact(4) {
                assert_eq!(
                    f32::from_le_bytes(bytes.try_into().unwrap()),
                    received as f32 / 1000.0,
                    "frame {received}"
                );
            }
        }
    })
    .await
    .unwrap();
    let _writer = producer.await.unwrap();
    assert_eq!(hub.status().audio_queue_dropped_frames, 0);
    // The producer deliberately stops after frame 300. The shared clock may
    // observe that end-of-stream before this assertion runs. Sample-exact
    // checks above already rule out any underrun inside the received stream.
    assert!(hub.status().audio_queue_underruns <= 1);
    hub.revoke_all_sessions();
    drain.abort();
    server.abort();
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
    assert_eq!(
        hub.status().authenticated_audio_connections,
        2,
        "the status count represents live authenticated connections"
    );

    for _ in 0..6 {
        socket_b
            .send(Message::Binary(
                uplink(profile_b, endpoint_b, ChannelId::CHANNEL_1, 1, 0.25).into(),
            ))
            .await
            .unwrap();
    }
    for _ in 0..6 {
        socket_a
            .send(Message::Binary(
                uplink(profile_a, endpoint_a, ChannelId::CHANNEL_1, 1, 0.75).into(),
            ))
            .await
            .unwrap();
    }
    let response = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let Some(Ok(Message::Binary(response))) = socket_a.next().await else {
                panic!("expected downlink")
            };
            if f32::from_le_bytes(response[64..68].try_into().unwrap()) != 0.0 {
                break response;
            }
        }
    })
    .await
    .unwrap();
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
    assert_eq!(
        hub.status().authenticated_audio_connections,
        0,
        "the count must return to zero after both sockets close"
    );
    server.abort();
}

#[tokio::test]
async fn receiver_without_uplink_gets_every_batched_frame_once() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hub = HubService::new(HubConfig::default());
    let source = hub
        .admit_session(Uuid::new_v4(), Uuid::new_v4(), ChannelId::CHANNEL_1, 1)
        .unwrap();
    let target = hub
        .admit_session(Uuid::new_v4(), Uuid::new_v4(), ChannelId::CHANNEL_1, 1)
        .unwrap();
    let server = tokio::spawn(hub.clone().serve_listener(listener));
    let (mut source_socket, _) = connect_async(format!("ws://{address}/audio"))
        .await
        .unwrap();
    let (mut target_socket, _) = connect_async(format!("ws://{address}/audio"))
        .await
        .unwrap();
    for (socket, admission) in [(&mut source_socket, &source), (&mut target_socket, &target)] {
        socket.send(Message::Text(serde_json::json!({"session_id": admission.session_id, "session_secret_b64": admission.session_secret_b64}).to_string().into())).await.unwrap();
        assert!(matches!(socket.next().await, Some(Ok(Message::Text(_)))));
    }
    for i in 1..=12 {
        source_socket
            .send(Message::Binary(
                uplink(
                    source.profile_id,
                    source.endpoint_id,
                    ChannelId::CHANNEL_1,
                    1,
                    i as f32 / 100.0,
                )
                .into(),
            ))
            .await
            .unwrap();
    }
    // Target never sends PCM. Old request/response mixing cannot pass this.
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut started = false;
        let mut previous_sequence = None;
        let mut received = 0;
        while received < 12 {
            let Some(Ok(Message::Binary(frame))) = target_socket.next().await else {
                panic!("missing output")
            };
            let header = AudioFrameHeader::from_bytes(&frame).unwrap();
            let value = f32::from_le_bytes(frame[64..68].try_into().unwrap());
            if !started && value == 0.0 {
                continue;
            }
            started = true;
            if let Some(previous) = previous_sequence {
                assert_eq!(header.sequence, previous + 1);
            }
            previous_sequence = Some(header.sequence);
            received += 1;
            for bytes in frame[64..].chunks_exact(4) {
                assert_eq!(
                    f32::from_le_bytes(bytes.try_into().unwrap()),
                    received as f32 / 100.0
                );
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(hub.status().audio_queue_dropped_frames, 0);
    // Non-finite payloads must not poison another Profile's audio.
    source_socket
        .send(Message::Binary(
            uplink(
                source.profile_id,
                source.endpoint_id,
                ChannelId::CHANNEL_1,
                1,
                f32::NAN,
            )
            .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while hub.status().rejected_audio_frames == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    hub.revoke_all_sessions();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while hub.status().authenticated_audio_connections != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    server.abort();
}
