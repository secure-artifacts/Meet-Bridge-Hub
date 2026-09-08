use std::io::Cursor;

use meet_bridge_native_broker::{
    MAX_NATIVE_MESSAGE_BYTES, NativeMessageError, read_message, write_message,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Fixture {
    kind: String,
}

#[test]
fn native_message_round_trip_uses_little_endian_length_prefix() {
    let mut bytes = Vec::new();
    let input = Fixture {
        kind: "HELLO".to_owned(),
    };
    write_message(&mut bytes, &input).unwrap();
    let output: Fixture = read_message(&mut Cursor::new(bytes)).unwrap();
    assert_eq!(output, input);
}

#[test]
fn oversized_native_message_is_rejected_before_allocation() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(u32::try_from(MAX_NATIVE_MESSAGE_BYTES + 1).unwrap()).to_le_bytes());
    let result = read_message::<Fixture>(&mut Cursor::new(bytes));
    assert!(matches!(result, Err(NativeMessageError::TooLarge)));
}
