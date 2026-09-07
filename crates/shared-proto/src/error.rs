use thiserror::Error;

#[derive(Error, Debug)]
pub enum ProtoError {
    #[error("Invalid magic byte sequence")]
    InvalidMagic,
    #[error("Unsupported protocol version: {0}.{1}")]
    UnsupportedVersion(u8, u8),
    #[error("Invalid header length: expected 64, got {0}")]
    InvalidHeaderLength(u16),
    #[error("Invalid channel ID: {0}")]
    InvalidChannel(u8),
    #[error("Buffer too small: expected at least {expected}, got {actual}")]
    BufferTooSmall { expected: usize, actual: usize },
    #[error("Payload length mismatch: expected {expected}, got {actual}")]
    PayloadMismatch { expected: usize, actual: usize },
    #[error("Serialization error: {0}")]
    Serialization(String),
}
