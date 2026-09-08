use meet_bridge_shared_proto::*;

#[test]
fn test_audio_header_roundtrip() {
    let header = AudioFrameHeader {
        magic: AUDIO_MAGIC,
        header_length: 64,
        protocol_version: 1,
        channel_id: 1,
        flags: audio_flags::UPLINK_PROFILE_BUS,
        samples_per_channel: 480,
        profile_id: [7u8; 16],
        endpoint_id: [8u8; 16],
        epoch: 1001,
        sequence: 42,
        payload_length: 1920,
    };

    let bytes = header.to_bytes();
    assert_eq!(bytes.len(), 64);
    assert_eq!(&bytes[0..4], b"MBF0");

    let parsed = AudioFrameHeader::from_bytes(&bytes).expect("Failed to parse header");
    assert_eq!(parsed.magic, AUDIO_MAGIC);
    assert_eq!(parsed.channel_id, 1);
    assert_eq!(parsed.epoch, 1001);
    assert_eq!(parsed.sequence, 42);
    assert_eq!(parsed.endpoint_id, [8u8; 16]);
    assert_eq!(parsed.payload_length, 1920);
}

#[test]
fn test_invalid_channel_rejected() {
    let mut bytes = [0u8; 64];
    bytes[0..4].copy_from_slice(b"MBF0");
    bytes[4..6].copy_from_slice(&64u16.to_le_bytes());
    bytes[8] = 4; // Channel 4 is invalid

    let err = AudioFrameHeader::from_bytes(&bytes);
    assert!(err.is_err());
}
