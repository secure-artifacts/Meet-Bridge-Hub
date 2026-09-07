use std::io::{Read, Write};

pub const MAX_NATIVE_MESSAGE_BYTES: usize = 1_048_576;

#[derive(Debug, thiserror::Error)]
pub enum NativeMessageError {
    #[error("native message length exceeds the allowed limit")]
    TooLarge,
    #[error("native message length is not valid on this platform")]
    InvalidLength,
    #[error("native messaging input/output error: {0}")]
    Io(#[from] std::io::Error),
    #[error("native message JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn read_message<T: serde::de::DeserializeOwned>(
    reader: &mut impl Read,
) -> Result<T, NativeMessageError> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length)?;
    let length = usize::try_from(u32::from_le_bytes(length))
        .map_err(|_| NativeMessageError::InvalidLength)?;
    if length > MAX_NATIVE_MESSAGE_BYTES {
        return Err(NativeMessageError::TooLarge);
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(serde_json::from_slice(&payload)?)
}

pub fn write_message<T: serde::Serialize>(
    writer: &mut impl Write,
    value: &T,
) -> Result<(), NativeMessageError> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > MAX_NATIVE_MESSAGE_BYTES {
        return Err(NativeMessageError::TooLarge);
    }
    let length = u32::try_from(payload.len()).map_err(|_| NativeMessageError::InvalidLength)?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}
