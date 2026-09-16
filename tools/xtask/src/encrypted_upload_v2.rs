use bota_device_sdk_core::protocol::{
    decode_encrypted_upload_v2_capabilities, decode_encrypted_upload_v2_signed_blob,
    decode_encrypted_upload_v2_status, decode_encrypted_upload_v2_transfer,
};
use chacha20poly1305::{
    ChaCha20Poly1305,
    aead::{AeadInOut, KeyInit as AeadKeyInit, inout::InOutBuf},
};
use hmac::{Hmac, Mac};
use hpke::{
    Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable,
    aead::ChaCha20Poly1305 as HpkeChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256,
};
use p256::ecdsa::{
    Signature, SigningKey, VerifyingKey,
    signature::hazmat::{PrehashSigner, PrehashVerifier},
};
use rand_chacha::{ChaCha20Rng, rand_core::SeedableRng};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fmt::Write as _, fs, path::Path};

const BUNDLE_PATH: &str = "protocol/vectors/encrypted-upload-v2.json";
const DIGEST_PATH: &str = "core/device-sdk-core/src/generated/encrypted_upload_v2_vectors.rs";
const CONTRACT_REVISION: &str = "encrypted-upload-v2-contract-v1";
const GENERATED_BY: &str = "cargo xtask encrypted-upload-v2 vectors generate";

const VECTOR_RNG_SEED: [u8; 32] = [0x42; 32];
const DEVICE_ROOT_KEY: [u8; 32] = [0x11; 32];
const DATA_KEY: [u8; 32] = [0x22; 32];
const BACKEND_P256_SIGNING_KEY: [u8; 32] = [0x33; 32];
const HPKE_RECIPIENT_PRIVATE_KEY: [u8; 32] = [0x44; 32];
const RECORDING_UUID: [u8; 16] = [
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
];
const UPLOAD_SESSION_UUID: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const RECIPIENT_KEY_UUID: [u8; 16] = [
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
];
const AUTH_NONCE: [u8; 16] = [0xa5; 16];
const RECORDING_GENERATION: u32 = 9;
const BINDING_GENERATION: u32 = 7;
const OWNER_REVISION: u32 = 3;
const POLICY_REVISION: u64 = 41;
const ISSUED_AT: u64 = 2_000_000_000;
const EXPIRES_AT: u64 = 2_000_003_600;
const NOW: u64 = 2_000_000_060;
const BLOCK_SIZE: u32 = 4096;
const TRANSPORT_SESSION_ID: u64 = 0x0000_1122_3344_5566;

const DOMAIN_LOCAL_WRAP: &[u8] = b"bota/enc-v2/local-wrap/v1";
const DOMAIN_WRAPPED_KEY_AAD: &[u8] = b"bota/enc-v2/wrapped-key-aad/v1";
const DOMAIN_BLOCK_AAD: &[u8] = b"bota/enc-v2/block-aad/v1";
const DOMAIN_TRAILER_KEY: &[u8] = b"bota/enc-v2/trailer-key/v1";
const DOMAIN_TRAILER_AUTH: &[u8] = b"bota/enc-v2/trailer-auth/v1";
const DOMAIN_MANIFEST_KEY: &[u8] = b"bota/enc-v2/manifest-key/v1";
const DOMAIN_MANIFEST_AUTH: &[u8] = b"bota/enc-v2/manifest-auth/v1";
const DOMAIN_STORAGE_IDENTITY: &[u8] = b"bota/enc-v2/storage-identity/v1";
const DOMAIN_UPLOAD_CONTEXT: &[u8] = b"bota/enc-v2/upload-context/v1";
const DOMAIN_HPKE_KEY_EXPORT: &[u8] = b"bota/enc-v2/hpke-key-export/v1";
const DOMAIN_DEVICE_IDENTITY: &[u8] = b"bota/enc-v2/device-identity/v1";
const DOMAIN_TENANT_CONTEXT: &[u8] = b"bota/enc-v2/tenant-context/v1";
const DOMAIN_STAGING_OBJECT: &[u8] = b"bota/enc-v2/staging-object/v1";
const DOMAIN_PUBLICATION: &[u8] = b"bota/enc-v2/publication/v1";

type HpkeKem = X25519HkdfSha256;
type HpkeAead = HpkeChaCha20Poly1305;
type TransferFixture = (&'static str, &'static str, Vec<u8>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    schema_version: u8,
    contract_revision: &'static str,
    generated_by: &'static str,
    keys: Keys,
    cases: Vec<VectorCase>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Keys {
    vector_rng_seed_hex: String,
    device_root_key_hex: String,
    data_key_hex: String,
    backend_p256_signing_key_hex: String,
    backend_p256_public_key_spki_der_hex: String,
    hpke_recipient_private_key_hex: String,
    hpke_recipient_public_key_hex: String,
    recording_uuid: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VectorCase {
    name: String,
    category: &'static str,
    operation: &'static str,
    input_hex: String,
    context: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_error: Option<&'static str>,
}

struct StorageFixture {
    bytes: Vec<u8>,
    header: [u8; 128],
    trailer: [u8; 144],
    block_count: u32,
    plaintext_length: u64,
    plaintext_sha256: [u8; 32],
    ciphertext_sha256: [u8; 32],
}

struct DocumentFixture {
    authorization: [u8; 408],
    manifest: [u8; 580],
    receipt: [u8; 336],
    tenant_context_digest: [u8; 32],
    device_identity_digest: [u8; 32],
    configuration_digest: [u8; 32],
    staging_object_digest: [u8; 32],
    storage_identity_digest: [u8; 32],
    upload_context_digest: [u8; 32],
    hpke_plaintext: [u8; 96],
}

pub fn generated_bundle(_root: &Path) -> Result<Vec<u8>, String> {
    let signing_key = signing_key()?;
    let verifying_key = VerifyingKey::from(&signing_key);
    let public_key_spki = p256_spki_der(&verifying_key);
    let hpke_private = hpke_private_key()?;
    let hpke_public = HpkeKem::sk_to_pk(&hpke_private);

    let partial_plaintext = b"OggS\0encrypted-upload-v2 partial block".to_vec();
    let multi_plaintext: Vec<u8> = (0..(BLOCK_SIZE as usize + 137))
        .map(|index| (index % 251) as u8)
        .collect();
    let partial = build_storage(&partial_plaintext)?;
    let multi = build_storage(&multi_plaintext)?;
    let documents = build_documents(&partial, 2, &signing_key, &hpke_public)?;

    // Exercise the reference parsers on every positive cryptographic fixture
    // before serializing the language-neutral expectations.
    parse_storage_object(&partial.bytes, &DATA_KEY)?;
    parse_storage_object(&multi.bytes, &DATA_KEY)?;
    parse_upload_authorization(&documents.authorization, &verifying_key)?;
    parse_upload_manifest(
        &documents.manifest,
        &DATA_KEY,
        &hpke_private,
        &documents.upload_context_digest,
        &documents.storage_identity_digest,
    )?;
    parse_completion_receipt(&documents.receipt, &verifying_key)?;

    let keys = Keys {
        vector_rng_seed_hex: hex(&VECTOR_RNG_SEED),
        device_root_key_hex: hex(&DEVICE_ROOT_KEY),
        data_key_hex: hex(&DATA_KEY),
        backend_p256_signing_key_hex: hex(&BACKEND_P256_SIGNING_KEY),
        backend_p256_public_key_spki_der_hex: hex(&public_key_spki),
        hpke_recipient_private_key_hex: hex(&HPKE_RECIPIENT_PRIVATE_KEY),
        hpke_recipient_public_key_hex: hex(hpke_public.to_bytes().as_slice()),
        recording_uuid: uuid(&RECORDING_UUID),
    };

    let mut cases = Vec::new();
    add_storage_cases(&mut cases, &partial, &multi);
    add_document_cases(
        &mut cases,
        &partial,
        &documents,
        &signing_key,
        &public_key_spki,
    )?;
    add_ble_cases(&mut cases, &partial, &documents)?;
    add_compatibility_cases(&mut cases);

    let bundle = Bundle {
        schema_version: 1,
        contract_revision: CONTRACT_REVISION,
        generated_by: GENERATED_BY,
        keys,
        cases,
    };
    let mut bytes = serde_json::to_vec_pretty(&bundle)
        .map_err(|error| format!("cannot serialize encrypted upload v2 vectors: {error}"))?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn generated_digest_source(bundle: &[u8]) -> String {
    let digest = sha256(bundle);
    format!(
        concat!(
            "// @generated by `cargo xtask encrypted-upload-v2 vectors generate`.\n",
            "// Source: {}\n",
            "// Do not edit by hand.\n\n",
            "pub const ENCRYPTED_UPLOAD_V2_VECTOR_SHA256: &str =\n",
            "    \"{}\";\n",
        ),
        BUNDLE_PATH,
        hex(&digest)
    )
}

pub fn generate(root: &Path, check: bool) -> Result<bool, String> {
    let bundle = generated_bundle(root)?;
    let digest = generated_digest_source(&bundle);
    let bundle_path = root.join(BUNDLE_PATH);
    let digest_path = root.join(DIGEST_PATH);
    let bundle_current = fs::read(&bundle_path).unwrap_or_default();
    let digest_current = fs::read_to_string(&digest_path).unwrap_or_default();
    if bundle_current == bundle && digest_current == digest {
        return Ok(false);
    }
    if check {
        return Err(
            "encrypted upload v2 vectors are stale; run `cargo xtask encrypted-upload-v2 vectors generate`"
                .to_owned(),
        );
    }
    if let Some(parent) = bundle_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    if let Some(parent) = digest_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    fs::write(&bundle_path, bundle)
        .map_err(|error| format!("cannot write {}: {error}", bundle_path.display()))?;
    fs::write(&digest_path, digest)
        .map_err(|error| format!("cannot write {}: {error}", digest_path.display()))?;
    Ok(true)
}

fn build_storage(plaintext: &[u8]) -> Result<StorageFixture, String> {
    let mut header = [0_u8; 128];
    header[0..8].copy_from_slice(b"BOTAENC2");
    put_u16(&mut header, 8, 2);
    put_u16(&mut header, 10, 128);
    put_u32(&mut header, 12, 1);
    put_u16(&mut header, 16, 1);
    put_u16(&mut header, 18, 1);
    put_u32(&mut header, 20, 7);
    put_u32(&mut header, 24, BLOCK_SIZE);
    header[28..44].copy_from_slice(&RECORDING_UUID);
    put_u32(&mut header, 44, RECORDING_GENERATION);
    header[48..60].copy_from_slice(&[0x55; 12]);
    header[60..72].copy_from_slice(&[0x66; 12]);

    let mut wrap_info = DOMAIN_LOCAL_WRAP.to_vec();
    wrap_info.extend_from_slice(&7_u32.to_le_bytes());
    let wrap_key = hkdf_sha256(&[], &DEVICE_ROOT_KEY, &wrap_info, 32)?;
    let mut wrap_aad = DOMAIN_WRAPPED_KEY_AAD.to_vec();
    wrap_aad.extend_from_slice(&header[0..72]);
    wrap_aad.extend_from_slice(&header[120..128]);
    let (wrapped_key, wrapped_tag) = seal_chacha(
        wrap_key.as_slice().try_into().expect("32-byte HKDF output"),
        (&header[60..72]).try_into().expect("12-byte nonce"),
        &wrap_aad,
        &DATA_KEY,
    )?;
    header[72..104].copy_from_slice(&wrapped_key);
    header[104..120].copy_from_slice(&wrapped_tag);

    let mut bytes = header.to_vec();
    for (block_index, block) in plaintext.chunks(BLOCK_SIZE as usize).enumerate() {
        let block_index =
            u32::try_from(block_index).map_err(|_| "storage block count exceeds u32".to_owned())?;
        let plaintext_offset = u64::from(block_index) * u64::from(BLOCK_SIZE);
        let nonce = block_nonce(
            (&header[48..60]).try_into().expect("12-byte nonce"),
            block_index,
        );
        let aad = block_aad(block_index, plaintext_offset, block.len())?;
        let (ciphertext, tag) = seal_chacha(&DATA_KEY, &nonce, &aad, block)?;
        bytes.extend_from_slice(
            &u16::try_from(block.len())
                .map_err(|_| "storage block length exceeds u16".to_owned())?
                .to_le_bytes(),
        );
        bytes.extend_from_slice(&[0, 0]);
        bytes.extend_from_slice(&ciphertext);
        bytes.extend_from_slice(&tag);
    }

    let block_count = u32::try_from(plaintext.len().div_ceil(BLOCK_SIZE as usize))
        .map_err(|_| "storage block count exceeds u32".to_owned())?;
    let plaintext_sha256 = sha256(plaintext);
    let body_sha256 = sha256(&bytes);
    let body_length = u64::try_from(bytes.len()).map_err(|_| "body too large".to_owned())?;
    let mut trailer = [0_u8; 144];
    trailer[0..8].copy_from_slice(b"BOTAEND2");
    put_u16(&mut trailer, 8, 2);
    put_u16(&mut trailer, 10, 144);
    trailer[12] = 1;
    trailer[13] = 1;
    put_u32(&mut trailer, 16, block_count);
    put_u64(&mut trailer, 20, plaintext.len() as u64);
    put_u64(&mut trailer, 28, body_length);
    trailer[36..68].copy_from_slice(&plaintext_sha256);
    trailer[68..100].copy_from_slice(&body_sha256);
    let manifest_salt = recording_salt();
    let trailer_key = hkdf_sha256(&manifest_salt, &DATA_KEY, DOMAIN_TRAILER_KEY, 32)?;
    let mut trailer_auth = DOMAIN_TRAILER_AUTH.to_vec();
    trailer_auth.extend_from_slice(&trailer[0..112]);
    trailer[112..144].copy_from_slice(&hmac_sha256(&trailer_key, &trailer_auth)?);
    bytes.extend_from_slice(&trailer);
    let ciphertext_sha256 = sha256(&bytes);
    Ok(StorageFixture {
        bytes,
        header,
        trailer,
        block_count,
        plaintext_length: plaintext.len() as u64,
        plaintext_sha256,
        ciphertext_sha256,
    })
}

fn build_documents(
    storage: &StorageFixture,
    environment: u8,
    signing_key: &SigningKey,
    hpke_public: &<HpkeKem as KemTrait>::PublicKey,
) -> Result<DocumentFixture, String> {
    let tenant_context_digest = digest_lp(
        DOMAIN_TENANT_CONTEXT,
        &[b"org_vector".as_slice(), b"proj_vector".as_slice()],
    )?;
    let device_identity_digest = digest_lp(DOMAIN_DEVICE_IDENTITY, &[b"BOTA-VECTOR-0001"])?;
    let configuration_digest = sha256(b"encrypted-upload-v2-vector-configuration-v1");
    let mut staging_material = DOMAIN_STAGING_OBJECT.to_vec();
    staging_material.extend_from_slice(&UPLOAD_SESSION_UUID);
    append_lp(&mut staging_material, b"bota-vector-staging")?;
    append_lp(&mut staging_material, b"encrypted/v2/vector-object")?;
    let staging_object_digest = sha256(&staging_material);

    let authorization = build_authorization(
        storage,
        environment,
        &tenant_context_digest,
        &device_identity_digest,
        &configuration_digest,
        &staging_object_digest,
        hpke_public,
        signing_key,
    )?;
    let upload_context_digest = sha256_concat(&[DOMAIN_UPLOAD_CONTEXT, &authorization]);
    let header_sha256 = sha256(&storage.header);
    let trailer_sha256 = sha256(&storage.trailer);
    let mut identity_material = DOMAIN_STORAGE_IDENTITY.to_vec();
    identity_material.extend_from_slice(&RECORDING_UUID);
    identity_material.extend_from_slice(&RECORDING_GENERATION.to_le_bytes());
    identity_material.extend_from_slice(&header_sha256);
    identity_material.extend_from_slice(&trailer_sha256);
    identity_material.extend_from_slice(&(storage.bytes.len() as u64).to_le_bytes());
    identity_material.extend_from_slice(&storage.ciphertext_sha256);
    identity_material.extend_from_slice(&storage.plaintext_length.to_le_bytes());
    identity_material.extend_from_slice(&storage.plaintext_sha256);
    let storage_identity_digest = sha256(&identity_material);

    let mut hpke_plaintext = [0_u8; 96];
    hpke_plaintext[0..32].copy_from_slice(&DATA_KEY);
    hpke_plaintext[32..64].copy_from_slice(&storage_identity_digest);
    hpke_plaintext[64..96].copy_from_slice(&upload_context_digest);
    let mut info = DOMAIN_HPKE_KEY_EXPORT.to_vec();
    info.extend_from_slice(&2_u16.to_le_bytes());
    info.extend_from_slice(&1_u16.to_le_bytes());
    let mut aad = upload_context_digest.to_vec();
    aad.extend_from_slice(&storage_identity_digest);
    let mut rng = ChaCha20Rng::from_seed(VECTOR_RNG_SEED);
    let (encapped, mut sender) = hpke::setup_sender_with_rng::<HpkeAead, HkdfSha256, HpkeKem>(
        &OpModeS::Base,
        hpke_public,
        &info,
        &mut rng,
    )
    .map_err(|error| format!("HPKE setup failed: {error}"))?;
    let sealed = sender
        .seal(&hpke_plaintext, &aad)
        .map_err(|error| format!("HPKE seal failed: {error}"))?;
    if sealed.len() != 112 {
        return Err(format!("HPKE sealed payload was {} bytes", sealed.len()));
    }

    let mut manifest = [0_u8; 580];
    manifest[0..8].copy_from_slice(b"BOTAMNF2");
    put_u16(&mut manifest, 8, 2);
    put_u16(&mut manifest, 10, 580);
    manifest[12] = 3;
    manifest[13] = 3;
    manifest[14] = 2;
    manifest[15] = 1;
    put_u16(&mut manifest, 16, 1);
    put_u16(&mut manifest, 18, 0x20);
    put_u16(&mut manifest, 20, 1);
    put_u16(&mut manifest, 22, 3);
    put_u16(&mut manifest, 24, 1);
    put_u16(&mut manifest, 26, 1);
    put_u32(&mut manifest, 28, OWNER_REVISION);
    put_u32(&mut manifest, 32, BINDING_GENERATION);
    put_u32(&mut manifest, 36, RECORDING_GENERATION);
    put_u32(&mut manifest, 40, BLOCK_SIZE);
    put_u32(&mut manifest, 44, storage.block_count);
    put_u32(&mut manifest, 48, 0x03);
    manifest[52..68].copy_from_slice(&UPLOAD_SESSION_UUID);
    manifest[68..84].copy_from_slice(&RECIPIENT_KEY_UUID);
    manifest[84..100].copy_from_slice(&RECORDING_UUID);
    manifest[100..132].copy_from_slice(&tenant_context_digest);
    manifest[132..164].copy_from_slice(&device_identity_digest);
    manifest[164..196].copy_from_slice(&configuration_digest);
    manifest[196..228].copy_from_slice(&staging_object_digest);
    manifest[228..260].copy_from_slice(&sha256(&authorization));
    put_u64(&mut manifest, 260, storage.bytes.len() as u64);
    put_u64(&mut manifest, 268, storage.plaintext_length);
    manifest[276..308].copy_from_slice(&storage.ciphertext_sha256);
    manifest[308..340].copy_from_slice(&storage.plaintext_sha256);
    manifest[340..372].copy_from_slice(&header_sha256);
    manifest[372..404].copy_from_slice(&trailer_sha256);
    manifest[404..436].copy_from_slice(encapped.to_bytes().as_slice());
    manifest[436..548].copy_from_slice(&sealed);
    let manifest_key = hkdf_sha256(&recording_salt(), &DATA_KEY, DOMAIN_MANIFEST_KEY, 32)?;
    let mut manifest_auth = DOMAIN_MANIFEST_AUTH.to_vec();
    manifest_auth.extend_from_slice(&manifest[0..548]);
    manifest[548..580].copy_from_slice(&hmac_sha256(&manifest_key, &manifest_auth)?);

    let mut publication_material = DOMAIN_PUBLICATION.to_vec();
    append_lp(&mut publication_material, b"bota-vector-final")?;
    append_lp(&mut publication_material, b"recordings/vector.ogg")?;
    publication_material.extend_from_slice(&storage.plaintext_sha256);
    let publication_identity_digest = sha256(&publication_material);
    let receipt = build_receipt(
        storage,
        environment,
        &tenant_context_digest,
        &device_identity_digest,
        &publication_identity_digest,
        &configuration_digest,
        signing_key,
    )?;

    Ok(DocumentFixture {
        authorization,
        manifest,
        receipt,
        tenant_context_digest,
        device_identity_digest,
        configuration_digest,
        staging_object_digest,
        storage_identity_digest,
        upload_context_digest,
        hpke_plaintext,
    })
}

#[allow(clippy::too_many_arguments)]
fn build_authorization(
    storage: &StorageFixture,
    environment: u8,
    tenant_context_digest: &[u8; 32],
    device_identity_digest: &[u8; 32],
    configuration_digest: &[u8; 32],
    staging_object_digest: &[u8; 32],
    hpke_public: &<HpkeKem as KemTrait>::PublicKey,
    signing_key: &SigningKey,
) -> Result<[u8; 408], String> {
    let mut bytes = [0_u8; 408];
    bytes[0..8].copy_from_slice(b"BOTAAUT2");
    put_u16(&mut bytes, 8, 2);
    put_u16(&mut bytes, 10, 408);
    bytes[12] = environment;
    bytes[13] = 3;
    bytes[14] = 3;
    bytes[15] = 2;
    bytes[16] = 0x07;
    put_u16(&mut bytes, 18, 1);
    put_u16(&mut bytes, 20, 0x20);
    put_u16(&mut bytes, 22, 1);
    put_u16(&mut bytes, 24, 3);
    put_u16(&mut bytes, 26, 1);
    put_u16(&mut bytes, 28, 1);
    put_u16(&mut bytes, 30, 0x07);
    put_u32(&mut bytes, 32, OWNER_REVISION);
    put_u32(&mut bytes, 36, BINDING_GENERATION);
    put_u32(&mut bytes, 40, RECORDING_GENERATION);
    put_u32(&mut bytes, 44, 5);
    put_u64(&mut bytes, 48, POLICY_REVISION);
    put_u64(&mut bytes, 56, ISSUED_AT);
    put_u64(&mut bytes, 64, EXPIRES_AT);
    put_u64(&mut bytes, 72, storage.bytes.len() as u64);
    put_u64(&mut bytes, 80, storage.bytes.len() as u64);
    bytes[88..104].copy_from_slice(&UPLOAD_SESSION_UUID);
    bytes[104..120].copy_from_slice(&RECIPIENT_KEY_UUID);
    bytes[120..136].copy_from_slice(&RECORDING_UUID);
    bytes[136..152].copy_from_slice(&AUTH_NONCE);
    bytes[152..184].copy_from_slice(hpke_public.to_bytes().as_slice());
    bytes[184..216].copy_from_slice(tenant_context_digest);
    bytes[216..248].copy_from_slice(device_identity_digest);
    bytes[248..280].copy_from_slice(configuration_digest);
    bytes[280..312].copy_from_slice(staging_object_digest);
    bytes[312..344].copy_from_slice(&storage.ciphertext_sha256);
    let signature = sign_low_s(signing_key, &bytes[0..344])?;
    bytes[344..408].copy_from_slice(&signature);
    Ok(bytes)
}

#[allow(clippy::too_many_arguments)]
fn build_receipt(
    storage: &StorageFixture,
    environment: u8,
    tenant_context_digest: &[u8; 32],
    device_identity_digest: &[u8; 32],
    publication_identity_digest: &[u8; 32],
    configuration_digest: &[u8; 32],
    signing_key: &SigningKey,
) -> Result<[u8; 336], String> {
    let mut bytes = [0_u8; 336];
    bytes[0..8].copy_from_slice(b"BOTARCPT");
    put_u16(&mut bytes, 8, 2);
    put_u16(&mut bytes, 10, 336);
    bytes[12] = environment;
    bytes[13] = 1;
    bytes[14] = 3;
    bytes[15] = 3;
    put_u32(&mut bytes, 16, OWNER_REVISION);
    put_u32(&mut bytes, 20, BINDING_GENERATION);
    put_u32(&mut bytes, 24, RECORDING_GENERATION);
    put_u32(&mut bytes, 28, 5);
    put_u64(&mut bytes, 32, ISSUED_AT + 120);
    put_u64(&mut bytes, 40, EXPIRES_AT + 120);
    bytes[48..64].copy_from_slice(&UPLOAD_SESSION_UUID);
    bytes[64..80].copy_from_slice(&RECORDING_UUID);
    bytes[80..112].copy_from_slice(tenant_context_digest);
    bytes[112..144].copy_from_slice(device_identity_digest);
    bytes[144..176].copy_from_slice(&storage.ciphertext_sha256);
    bytes[176..208].copy_from_slice(&storage.plaintext_sha256);
    bytes[208..240].copy_from_slice(publication_identity_digest);
    bytes[240..272].copy_from_slice(configuration_digest);
    let signature = sign_low_s(signing_key, &bytes[0..272])?;
    bytes[272..336].copy_from_slice(&signature);
    Ok(bytes)
}

pub fn parse_storage_object(bytes: &[u8], data_key: &[u8; 32]) -> Result<Value, String> {
    if bytes.len() < 128 + 144 {
        return Err("invalid_length".to_owned());
    }
    if &bytes[0..8] != b"BOTAENC2" {
        return Err("invalid_magic".to_owned());
    }
    if read_u16(bytes, 8)? != 2 {
        return Err("unsupported_version".to_owned());
    }
    if read_u16(bytes, 10)? != 128 {
        return Err("invalid_length".to_owned());
    }
    if read_u32(bytes, 12)? != 1 || read_u16(bytes, 16)? != 1 || read_u16(bytes, 18)? != 1 {
        return Err("unsupported_suite".to_owned());
    }
    if bytes[120..128].iter().any(|byte| *byte != 0) {
        return Err("noncanonical_encoding".to_owned());
    }
    let block_size = read_u32(bytes, 24)?;
    if block_size == 0 || block_size > u32::from(u16::MAX) {
        return Err("invalid_length".to_owned());
    }
    let trailer_offset = bytes
        .len()
        .checked_sub(144)
        .ok_or_else(|| "invalid_length".to_owned())?;
    let trailer = &bytes[trailer_offset..];
    if &trailer[0..8] != b"BOTAEND2" {
        return Err("invalid_magic".to_owned());
    }
    if read_u16(trailer, 8)? != 2 {
        return Err("unsupported_version".to_owned());
    }
    if read_u16(trailer, 10)? != 144 || read_u64(trailer, 28)? != trailer_offset as u64 {
        return Err("invalid_length".to_owned());
    }
    if trailer[12] != 1 || trailer[13] != 1 || trailer[14..16].iter().any(|byte| *byte != 0) {
        return Err("noncanonical_encoding".to_owned());
    }
    if trailer[100..112].iter().any(|byte| *byte != 0) {
        return Err("noncanonical_encoding".to_owned());
    }

    let expected_body_digest = sha256(&bytes[..trailer_offset]);
    if !constant_time_eq(&expected_body_digest, &trailer[68..100]) {
        return Err("digest_mismatch".to_owned());
    }
    let trailer_key = hkdf_sha256(&recording_salt(), data_key, DOMAIN_TRAILER_KEY, 32)?;
    let mut trailer_auth = DOMAIN_TRAILER_AUTH.to_vec();
    trailer_auth.extend_from_slice(&trailer[0..112]);
    let expected_tag = hmac_sha256(&trailer_key, &trailer_auth)?;
    if !constant_time_eq(&expected_tag, &trailer[112..144]) {
        return Err("authentication_failed".to_owned());
    }

    let block_count = read_u32(trailer, 16)?;
    let plaintext_length = read_u64(trailer, 20)?;
    let mut offset = 128_usize;
    let mut plaintext_offset = 0_u64;
    let mut plaintext = Vec::new();
    for block_index in 0..block_count {
        let frame_header_end = offset
            .checked_add(4)
            .ok_or_else(|| "invalid_length".to_owned())?;
        if frame_header_end > trailer_offset {
            return Err("invalid_length".to_owned());
        }
        let block_length = usize::from(read_u16(bytes, offset)?);
        if block_length == 0 || block_length > block_size as usize {
            return Err("invalid_length".to_owned());
        }
        if read_u16(bytes, offset + 2)? != 0 {
            return Err("noncanonical_encoding".to_owned());
        }
        let ciphertext_start = offset + 4;
        let ciphertext_end = ciphertext_start
            .checked_add(block_length)
            .ok_or_else(|| "invalid_length".to_owned())?;
        let frame_end = ciphertext_end
            .checked_add(16)
            .ok_or_else(|| "invalid_length".to_owned())?;
        if frame_end > trailer_offset {
            return Err("invalid_length".to_owned());
        }
        let nonce = block_nonce(
            bytes[48..60].try_into().expect("validated header nonce"),
            block_index,
        );
        let aad = block_aad(block_index, plaintext_offset, block_length)?;
        let block = open_chacha(
            data_key,
            &nonce,
            &aad,
            &bytes[ciphertext_start..ciphertext_end],
            bytes[ciphertext_end..frame_end]
                .try_into()
                .expect("validated block tag"),
        )?;
        plaintext.extend_from_slice(&block);
        plaintext_offset = plaintext_offset
            .checked_add(block_length as u64)
            .ok_or_else(|| "invalid_length".to_owned())?;
        offset = frame_end;
    }
    if offset != trailer_offset || plaintext_offset != plaintext_length {
        return Err("invalid_length".to_owned());
    }
    let plaintext_digest = sha256(&plaintext);
    if !constant_time_eq(&plaintext_digest, &trailer[36..68]) {
        return Err("digest_mismatch".to_owned());
    }
    let ciphertext_digest = sha256(bytes);
    Ok(json!({
        "formatVersion": 2,
        "blockSize": block_size,
        "blockCount": block_count,
        "plaintextLength": plaintext_length,
        "ciphertextLength": bytes.len(),
        "plaintextSha256Hex": hex(&plaintext_digest),
        "ciphertextSha256Hex": hex(&ciphertext_digest),
        "recordingUuid": uuid(bytes[28..44].try_into().expect("validated recording UUID")),
        "recordingGeneration": read_u32(bytes, 44)?,
    }))
}

pub fn parse_upload_authorization(
    bytes: &[u8],
    verifying_key: &VerifyingKey,
) -> Result<Value, String> {
    require_document(bytes, 408, b"BOTAAUT2")?;
    if bytes[12] > 2
        || bytes[13] != 3
        || bytes[14] != 3
        || bytes[15] > 2
        || bytes[16] & !0x07 != 0
        || bytes[17] != 0
        || read_u16(bytes, 18)? != 1
        || read_u16(bytes, 20)? != 0x20
        || read_u16(bytes, 22)? != 1
        || read_u16(bytes, 24)? != 3
        || read_u16(bytes, 26)? != 1
        || read_u16(bytes, 28)? != 1
        || read_u16(bytes, 30)? & !0x07 != 0
    {
        return Err("noncanonical_encoding".to_owned());
    }
    verify_low_s(verifying_key, &bytes[..344], &bytes[344..408])?;
    Ok(json!({
        "environment": bytes[12],
        "transportProfile": bytes[13],
        "storageFormat": bytes[14],
        "policy": bytes[15],
        "ownerRevision": read_u32(bytes, 32)?,
        "bindingGeneration": read_u32(bytes, 36)?,
        "recordingGeneration": read_u32(bytes, 40)?,
        "issuedAt": read_u64(bytes, 56)?,
        "expiresAt": read_u64(bytes, 64)?,
        "ciphertextLength": read_u64(bytes, 72)?,
        "sessionUuid": uuid(bytes[88..104].try_into().expect("validated session UUID")),
        "recordingUuid": uuid(bytes[120..136].try_into().expect("validated recording UUID")),
        "ciphertextSha256Hex": hex(&bytes[312..344]),
        "signatureValid": true,
    }))
}

pub fn parse_upload_manifest(
    bytes: &[u8],
    data_key: &[u8; 32],
    recipient_private_key: &<HpkeKem as KemTrait>::PrivateKey,
    upload_context_digest: &[u8; 32],
    storage_identity_digest: &[u8; 32],
) -> Result<Value, String> {
    require_document(bytes, 580, b"BOTAMNF2")?;
    if bytes[12] != 3
        || bytes[13] != 3
        || bytes[14] > 2
        || !(1..=3).contains(&bytes[15])
        || read_u16(bytes, 16)? != 1
        || read_u16(bytes, 18)? != 0x20
        || read_u16(bytes, 20)? != 1
        || read_u16(bytes, 22)? != 3
        || read_u16(bytes, 24)? != 1
        || read_u16(bytes, 26)? != 1
        || read_u32(bytes, 48)? & !0x07 != 0
    {
        return Err("noncanonical_encoding".to_owned());
    }
    let manifest_key = hkdf_sha256(&recording_salt(), data_key, DOMAIN_MANIFEST_KEY, 32)?;
    let mut auth = DOMAIN_MANIFEST_AUTH.to_vec();
    auth.extend_from_slice(&bytes[..548]);
    let expected_tag = hmac_sha256(&manifest_key, &auth)?;
    if !constant_time_eq(&expected_tag, &bytes[548..580]) {
        return Err("authentication_failed".to_owned());
    }
    let encapped = <HpkeKem as KemTrait>::EncappedKey::from_bytes(&bytes[404..436])
        .map_err(|_| "invalid_hpke_key".to_owned())?;
    let mut info = DOMAIN_HPKE_KEY_EXPORT.to_vec();
    info.extend_from_slice(&2_u16.to_le_bytes());
    info.extend_from_slice(&1_u16.to_le_bytes());
    let mut aad = upload_context_digest.to_vec();
    aad.extend_from_slice(storage_identity_digest);
    let mut receiver = hpke::setup_receiver::<HpkeAead, HkdfSha256, HpkeKem>(
        &OpModeR::Base,
        recipient_private_key,
        &encapped,
        &info,
    )
    .map_err(|_| "hpke_open_failed".to_owned())?;
    let opened = receiver
        .open(&bytes[436..548], &aad)
        .map_err(|_| "hpke_open_failed".to_owned())?;
    if opened.len() != 96
        || !constant_time_eq(&opened[0..32], data_key)
        || !constant_time_eq(&opened[32..64], storage_identity_digest)
        || !constant_time_eq(&opened[64..96], upload_context_digest)
    {
        return Err("identity_mismatch".to_owned());
    }
    Ok(json!({
        "transportProfile": bytes[12],
        "storageFormat": bytes[13],
        "policy": bytes[14],
        "selectedChannel": bytes[15],
        "ownerRevision": read_u32(bytes, 28)?,
        "bindingGeneration": read_u32(bytes, 32)?,
        "recordingGeneration": read_u32(bytes, 36)?,
        "blockSize": read_u32(bytes, 40)?,
        "blockCount": read_u32(bytes, 44)?,
        "ciphertextLength": read_u64(bytes, 260)?,
        "plaintextLength": read_u64(bytes, 268)?,
        "ciphertextSha256Hex": hex(&bytes[276..308]),
        "plaintextSha256Hex": hex(&bytes[308..340]),
        "sessionUuid": uuid(bytes[52..68].try_into().expect("validated session UUID")),
        "recordingUuid": uuid(bytes[84..100].try_into().expect("validated recording UUID")),
        "uploadContextDigestHex": hex(upload_context_digest),
        "storageIdentityDigestHex": hex(storage_identity_digest),
        "hpkePlaintextHex": hex(&opened),
        "manifestTagValid": true,
    }))
}

pub fn parse_completion_receipt(
    bytes: &[u8],
    verifying_key: &VerifyingKey,
) -> Result<Value, String> {
    require_document(bytes, 336, b"BOTARCPT")?;
    if bytes[12] > 2 || bytes[13] != 1 || bytes[14] != 3 || bytes[15] != 3 {
        return Err("noncanonical_encoding".to_owned());
    }
    verify_low_s(verifying_key, &bytes[..272], &bytes[272..336])?;
    Ok(json!({
        "environment": bytes[12],
        "transportProfile": bytes[14],
        "storageFormat": bytes[15],
        "ownerRevision": read_u32(bytes, 16)?,
        "bindingGeneration": read_u32(bytes, 20)?,
        "recordingGeneration": read_u32(bytes, 24)?,
        "issuedAt": read_u64(bytes, 32)?,
        "expiresAt": read_u64(bytes, 40)?,
        "sessionUuid": uuid(bytes[48..64].try_into().expect("validated session UUID")),
        "recordingUuid": uuid(bytes[64..80].try_into().expect("validated recording UUID")),
        "ciphertextSha256Hex": hex(&bytes[144..176]),
        "plaintextSha256Hex": hex(&bytes[176..208]),
        "signatureValid": true,
    }))
}

fn add_storage_cases(
    cases: &mut Vec<VectorCase>,
    partial: &StorageFixture,
    multi: &StorageFixture,
) {
    let context = json!({ "dataKeyHex": hex(&DATA_KEY) });
    cases.push(valid_case(
        "storage-partial-block",
        "storage",
        "verifyStorageObject",
        &partial.bytes,
        context.clone(),
        json!({ "normalized": storage_normalized(partial) }),
    ));
    cases.push(valid_case(
        "storage-multi-block",
        "storage",
        "verifyStorageObject",
        &multi.bytes,
        context.clone(),
        json!({ "normalized": storage_normalized(multi) }),
    ));

    let mut zero_block = partial.bytes.clone();
    zero_block[128..130].fill(0);
    let mut oversize = partial.bytes.clone();
    oversize[128..130].copy_from_slice(&(BLOCK_SIZE as u16 + 1).to_le_bytes());
    let mut trailing = partial.bytes.clone();
    trailing.push(0);
    let malformed = vec![
        (
            "storage-wrong-magic",
            mutate(&partial.bytes, 0, 0xff),
            "invalid_magic",
        ),
        (
            "storage-wrong-version",
            mutate(&partial.bytes, 8, 0x03),
            "unsupported_version",
        ),
        (
            "storage-wrong-header-length",
            mutate(&partial.bytes, 10, 0x7f),
            "invalid_length",
        ),
        (
            "storage-nonzero-reserved",
            mutate(&partial.bytes, 120, 1),
            "noncanonical_encoding",
        ),
        ("storage-zero-block-length", zero_block, "invalid_length"),
        ("storage-oversize-block", oversize, "invalid_length"),
        (
            "storage-altered-block-tag",
            mutate(&partial.bytes, partial.bytes.len() - 145, 1),
            "digest_mismatch",
        ),
        (
            "storage-altered-trailer-tag",
            mutate(&partial.bytes, partial.bytes.len() - 1, 1),
            "authentication_failed",
        ),
        (
            "storage-altered-plaintext-hash",
            mutate(&partial.bytes, partial.bytes.len() - 144 + 36, 1),
            "authentication_failed",
        ),
        (
            "storage-altered-ciphertext-hash",
            mutate(&partial.bytes, partial.bytes.len() - 144 + 68, 1),
            "digest_mismatch",
        ),
        ("storage-trailing-byte", trailing, "invalid_length"),
    ];
    for (name, bytes, error) in malformed {
        cases.push(error_case(
            name,
            "storage",
            "verifyStorageObject",
            &bytes,
            context.clone(),
            error,
        ));
    }
}

fn storage_normalized(storage: &StorageFixture) -> Value {
    json!({
        "formatVersion": 2,
        "blockSize": BLOCK_SIZE,
        "blockCount": storage.block_count,
        "plaintextLength": storage.plaintext_length,
        "ciphertextLength": storage.bytes.len(),
        "plaintextSha256Hex": hex(&storage.plaintext_sha256),
        "ciphertextSha256Hex": hex(&storage.ciphertext_sha256),
        "recordingUuid": uuid(&RECORDING_UUID),
        "recordingGeneration": RECORDING_GENERATION,
    })
}

fn add_document_cases(
    cases: &mut Vec<VectorCase>,
    storage: &StorageFixture,
    documents: &DocumentFixture,
    signing_key: &SigningKey,
    public_key_spki: &[u8],
) -> Result<(), String> {
    let hpke_private = hpke_private_key()?;
    let hpke_public = HpkeKem::sk_to_pk(&hpke_private);
    let authorization_context = json!({
        "nowSeconds": NOW,
        "expectedEnvironment": 2,
        "backendP256PublicKeySpkiDerHex": hex(public_key_spki),
        "expectedTenantContextDigestHex": hex(&documents.tenant_context_digest),
        "expectedDeviceIdentityDigestHex": hex(&documents.device_identity_digest),
        "expectedConfigurationDigestHex": hex(&documents.configuration_digest),
        "expectedStagingObjectDigestHex": hex(&documents.staging_object_digest),
        "expectedCiphertextSha256Hex": hex(&storage.ciphertext_sha256),
        "expectedBindingGeneration": BINDING_GENERATION,
        "expectedRecordingGeneration": RECORDING_GENERATION,
        "expectedSessionUuid": uuid(&UPLOAD_SESSION_UUID),
        "expectedRecordingUuid": uuid(&RECORDING_UUID),
    });
    for (name, environment) in [
        ("authorization-development", 0_u8),
        ("authorization-gamma", 1_u8),
        ("authorization-production", 2_u8),
    ] {
        let authorization = build_authorization(
            storage,
            environment,
            &documents.tenant_context_digest,
            &documents.device_identity_digest,
            &documents.configuration_digest,
            &documents.staging_object_digest,
            &hpke_public,
            signing_key,
        )?;
        let mut context = authorization_context.clone();
        context["expectedEnvironment"] = json!(environment);
        cases.push(valid_case(
            name,
            "signed-document",
            "verifyUploadAuthorization",
            &authorization,
            context,
            json!({ "normalized": authorization_normalized(&authorization) }),
        ));
    }

    let manifest_context = json!({
        "dataKeyHex": hex(&DATA_KEY),
        "hpkeRecipientPrivateKeyHex": hex(&HPKE_RECIPIENT_PRIVATE_KEY),
        "expectedTenantContextDigestHex": hex(&documents.tenant_context_digest),
        "expectedDeviceIdentityDigestHex": hex(&documents.device_identity_digest),
        "expectedConfigurationDigestHex": hex(&documents.configuration_digest),
        "expectedStagingObjectDigestHex": hex(&documents.staging_object_digest),
        "expectedCiphertextSha256Hex": hex(&storage.ciphertext_sha256),
        "expectedPlaintextSha256Hex": hex(&storage.plaintext_sha256),
        "expectedBindingGeneration": BINDING_GENERATION,
        "expectedRecordingGeneration": RECORDING_GENERATION,
        "expectedOwnerRevision": OWNER_REVISION,
        "expectedSessionUuid": uuid(&UPLOAD_SESSION_UUID),
        "expectedRecordingUuid": uuid(&RECORDING_UUID),
    });
    let manifest_normalized = manifest_normalized(storage, documents);
    for name in ["key-export-hpke", "manifest-hpke"] {
        cases.push(valid_case(
            name,
            "signed-document",
            "verifyUploadManifest",
            &documents.manifest,
            manifest_context.clone(),
            json!({ "normalized": manifest_normalized.clone() }),
        ));
    }

    let receipt_context = json!({
        "nowSeconds": NOW + 180,
        "expectedEnvironment": 2,
        "backendP256PublicKeySpkiDerHex": hex(public_key_spki),
        "expectedTenantContextDigestHex": hex(&documents.tenant_context_digest),
        "expectedDeviceIdentityDigestHex": hex(&documents.device_identity_digest),
        "expectedConfigurationDigestHex": hex(&documents.configuration_digest),
        "expectedCiphertextSha256Hex": hex(&storage.ciphertext_sha256),
        "expectedPlaintextSha256Hex": hex(&storage.plaintext_sha256),
        "expectedBindingGeneration": BINDING_GENERATION,
        "expectedRecordingGeneration": RECORDING_GENERATION,
        "expectedOwnerRevision": OWNER_REVISION,
        "expectedSessionUuid": uuid(&UPLOAD_SESSION_UUID),
        "expectedRecordingUuid": uuid(&RECORDING_UUID),
    });
    cases.push(valid_case(
        "completion-receipt",
        "signed-document",
        "verifyCompletionReceipt",
        &documents.receipt,
        receipt_context.clone(),
        json!({ "normalized": receipt_normalized(storage, "first") }),
    ));
    let mut idempotent_context = receipt_context.clone();
    idempotent_context["previousReceiptSha256Hex"] = json!(hex(&sha256(&documents.receipt)));
    cases.push(valid_case(
        "receipt-idempotent-replay",
        "signed-document",
        "verifyCompletionReceipt",
        &documents.receipt,
        idempotent_context,
        json!({ "normalized": receipt_normalized(storage, "idempotent") }),
    ));

    let mut high_s = documents.authorization;
    high_s[344..408].copy_from_slice(&to_high_s(&documents.authorization[344..408])?);
    cases.push(error_case(
        "authorization-high-s-signature",
        "signed-document",
        "verifyUploadAuthorization",
        &high_s,
        authorization_context.clone(),
        "signature_invalid",
    ));
    cases.push(error_case(
        "authorization-altered-signature",
        "signed-document",
        "verifyUploadAuthorization",
        &mutate(&documents.authorization, 344, 1),
        authorization_context.clone(),
        "signature_invalid",
    ));
    let mut expired_context = authorization_context.clone();
    expired_context["nowSeconds"] = json!(EXPIRES_AT + 1);
    cases.push(error_case(
        "authorization-expired",
        "signed-document",
        "verifyUploadAuthorization",
        &documents.authorization,
        expired_context,
        "expired",
    ));
    let mismatch_contexts = [
        (
            "authorization-wrong-environment",
            "expectedEnvironment",
            json!(1),
            "environment_mismatch",
        ),
        (
            "authorization-wrong-tenant",
            "expectedTenantContextDigestHex",
            json!(hex(&[0x91; 32])),
            "identity_mismatch",
        ),
        (
            "authorization-wrong-device",
            "expectedDeviceIdentityDigestHex",
            json!(hex(&[0x92; 32])),
            "identity_mismatch",
        ),
        (
            "authorization-wrong-binding",
            "expectedBindingGeneration",
            json!(BINDING_GENERATION + 1),
            "binding_generation_mismatch",
        ),
        (
            "authorization-wrong-recording",
            "expectedRecordingUuid",
            json!(uuid(&[0x93; 16])),
            "recording_identity_mismatch",
        ),
        (
            "authorization-wrong-staging",
            "expectedStagingObjectDigestHex",
            json!(hex(&[0x94; 32])),
            "identity_mismatch",
        ),
        (
            "authorization-wrong-ciphertext-digest",
            "expectedCiphertextSha256Hex",
            json!(hex(&[0x95; 32])),
            "identity_mismatch",
        ),
    ];
    for (name, key, value, error) in mismatch_contexts {
        let mut context = authorization_context.clone();
        context[key] = value;
        cases.push(error_case(
            name,
            "signed-document",
            "verifyUploadAuthorization",
            &documents.authorization,
            context,
            error,
        ));
    }

    let mut wrong_recipient_context = manifest_context.clone();
    wrong_recipient_context["hpkeRecipientPrivateKeyHex"] = json!(hex(&[0x45; 32]));
    cases.push(error_case(
        "manifest-wrong-recipient-key",
        "signed-document",
        "verifyUploadManifest",
        &documents.manifest,
        wrong_recipient_context,
        "hpke_open_failed",
    ));
    cases.push(error_case(
        "manifest-altered-hpke-payload",
        "signed-document",
        "verifyUploadManifest",
        &mutate(&documents.manifest, 436, 1),
        manifest_context.clone(),
        "authentication_failed",
    ));
    cases.push(error_case(
        "manifest-altered-tag",
        "signed-document",
        "verifyUploadManifest",
        &mutate(&documents.manifest, 579, 1),
        manifest_context.clone(),
        "authentication_failed",
    ));
    for (name, key, bytes) in [
        (
            "manifest-wrong-tenant",
            "expectedTenantContextDigestHex",
            [0x81; 32],
        ),
        (
            "manifest-wrong-device",
            "expectedDeviceIdentityDigestHex",
            [0x82; 32],
        ),
        (
            "manifest-wrong-configuration",
            "expectedConfigurationDigestHex",
            [0x83; 32],
        ),
        (
            "manifest-wrong-staging",
            "expectedStagingObjectDigestHex",
            [0x84; 32],
        ),
        (
            "manifest-wrong-ciphertext-digest",
            "expectedCiphertextSha256Hex",
            [0x85; 32],
        ),
    ] {
        let mut context = manifest_context.clone();
        context[key] = json!(hex(&bytes));
        cases.push(error_case(
            name,
            "signed-document",
            "verifyUploadManifest",
            &documents.manifest,
            context,
            "identity_mismatch",
        ));
    }

    let mut high_s_receipt = documents.receipt;
    high_s_receipt[272..336].copy_from_slice(&to_high_s(&documents.receipt[272..336])?);
    cases.push(error_case(
        "receipt-high-s-signature",
        "signed-document",
        "verifyCompletionReceipt",
        &high_s_receipt,
        receipt_context.clone(),
        "signature_invalid",
    ));
    cases.push(error_case(
        "receipt-altered-signature",
        "signed-document",
        "verifyCompletionReceipt",
        &mutate(&documents.receipt, 272, 1),
        receipt_context.clone(),
        "signature_invalid",
    ));
    let mut receipt_expired_context = receipt_context.clone();
    receipt_expired_context["nowSeconds"] = json!(EXPIRES_AT + 121);
    cases.push(error_case(
        "receipt-expired",
        "signed-document",
        "verifyCompletionReceipt",
        &documents.receipt,
        receipt_expired_context,
        "expired",
    ));
    let mut conflict_context = receipt_context;
    conflict_context["previousReceiptSha256Hex"] = json!(hex(&[0x77; 32]));
    cases.push(error_case(
        "receipt-replay-conflict",
        "signed-document",
        "verifyCompletionReceipt",
        &documents.receipt,
        conflict_context,
        "replay_conflict",
    ));
    Ok(())
}

fn authorization_normalized(bytes: &[u8; 408]) -> Value {
    json!({
        "environment": bytes[12],
        "transportProfile": 3,
        "storageFormat": 3,
        "policy": 2,
        "ownerRevision": OWNER_REVISION,
        "bindingGeneration": BINDING_GENERATION,
        "recordingGeneration": RECORDING_GENERATION,
        "issuedAt": ISSUED_AT,
        "expiresAt": EXPIRES_AT,
        "ciphertextLength": read_u64(bytes, 72).expect("fixed authorization"),
        "ciphertextSha256Hex": hex(&bytes[312..344]),
        "sessionUuid": uuid(&UPLOAD_SESSION_UUID),
        "recordingUuid": uuid(&RECORDING_UUID),
        "signatureValid": true,
    })
}

fn manifest_normalized(storage: &StorageFixture, documents: &DocumentFixture) -> Value {
    json!({
        "transportProfile": 3,
        "storageFormat": 3,
        "policy": 2,
        "selectedChannel": 1,
        "ownerRevision": OWNER_REVISION,
        "bindingGeneration": BINDING_GENERATION,
        "recordingGeneration": RECORDING_GENERATION,
        "blockSize": BLOCK_SIZE,
        "blockCount": storage.block_count,
        "ciphertextLength": storage.bytes.len(),
        "plaintextLength": storage.plaintext_length,
        "ciphertextSha256Hex": hex(&storage.ciphertext_sha256),
        "plaintextSha256Hex": hex(&storage.plaintext_sha256),
        "sessionUuid": uuid(&UPLOAD_SESSION_UUID),
        "recordingUuid": uuid(&RECORDING_UUID),
        "uploadContextDigestHex": hex(&documents.upload_context_digest),
        "storageIdentityDigestHex": hex(&documents.storage_identity_digest),
        "hpkePlaintextHex": hex(&documents.hpke_plaintext),
        "manifestTagValid": true,
    })
}

fn receipt_normalized(storage: &StorageFixture, replay: &str) -> Value {
    json!({
        "environment": 2,
        "transportProfile": 3,
        "storageFormat": 3,
        "ownerRevision": OWNER_REVISION,
        "bindingGeneration": BINDING_GENERATION,
        "recordingGeneration": RECORDING_GENERATION,
        "issuedAt": ISSUED_AT + 120,
        "expiresAt": EXPIRES_AT + 120,
        "ciphertextSha256Hex": hex(&storage.ciphertext_sha256),
        "plaintextSha256Hex": hex(&storage.plaintext_sha256),
        "sessionUuid": uuid(&UPLOAD_SESSION_UUID),
        "recordingUuid": uuid(&RECORDING_UUID),
        "signatureValid": true,
        "receiptReplay": replay,
    })
}

fn add_ble_cases(
    cases: &mut Vec<VectorCase>,
    storage: &StorageFixture,
    documents: &DocumentFixture,
) -> Result<(), String> {
    let capability = capability_value();
    decode_encrypted_upload_v2_capabilities(&capability)
        .map_err(|error| format!("generated capability rejected: {error}"))?;
    cases.push(valid_case(
        "capability",
        "ble",
        "decodeCapabilities",
        &capability,
        json!({}),
        json!({
            "decodedType": "capability",
            "encodedHex": hex(&capability),
            "normalized": {
                "flags": 0x7f,
                "highestTransferProfileVersion": 2,
                "maximumSignedBlobBytes": 1024,
                "maximumManifestBytes": 1024,
                "maximumDataPayloadBytes": 244,
                "maximumWindowPackets": 16,
                "durableCheckpointIntervalBlocks": 8,
                "maximumMissingSequences": 16
            }
        }),
    ));

    let authorization_digest = sha256(&documents.authorization);
    let blob_frames = vec![
        (
            "ble-blob-begin",
            blob_begin(1, 0x0102_0304, 408, &authorization_digest),
            "blobBegin",
        ),
        (
            "ble-blob-data",
            blob_data(1, 0x0102_0304, 0, &documents.authorization[..48])?,
            "blobData",
        ),
        (
            "ble-blob-commit",
            blob_simple(0x62, 1, 0x0102_0304),
            "blobCommit",
        ),
        (
            "ble-blob-abort",
            blob_simple(0x63, 1, 0x0102_0304),
            "blobAbort",
        ),
        (
            "ble-blob-result",
            blob_result(1, 0x0102_0304, 0),
            "blobResult",
        ),
    ];
    for (name, frame, decoded_type) in blob_frames {
        decode_encrypted_upload_v2_signed_blob(&frame)
            .map_err(|error| format!("generated {name} rejected: {error}"))?;
        cases.push(valid_case(
            name,
            "ble",
            "decodeSignedBlob",
            &frame,
            json!({}),
            json!({ "decodedType": decoded_type, "encodedHex": hex(&frame) }),
        ));
    }
    let duplicate = blob_data(1, 0x0102_0304, 0, &documents.authorization[..48])?;
    cases.push(valid_case(
        "ble-blob-duplicate-chunk-idempotent",
        "ble",
        "decodeSignedBlob",
        &duplicate,
        json!({ "assembledPrefixHex": hex(&documents.authorization[..48]) }),
        json!({ "decodedType": "blobData", "encodedHex": hex(&duplicate), "accepted": true }),
    ));

    let prefix_empty = sha256(&[]);
    let prefix_first = sha256(&storage.bytes[..64.min(storage.bytes.len())]);
    let frames = transfer_frames(storage, documents, &prefix_empty, &prefix_first)?;
    for (name, decoded_type, frame) in frames {
        decode_encrypted_upload_v2_transfer(&frame)
            .map_err(|error| format!("generated {name} rejected: {error}"))?;
        cases.push(valid_case(
            name,
            "ble",
            "decodeTransfer",
            &frame,
            json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
            json!({
                "decodedType": decoded_type,
                "encodedHex": hex(&frame),
                "normalized": {
                    "messageType": frame[0],
                    "transportSessionId": TRANSPORT_SESSION_ID,
                    "flags": 0
                }
            }),
        ));
    }

    let status = status_value();
    decode_encrypted_upload_v2_status(&status)
        .map_err(|error| format!("generated status rejected: {error}"))?;

    let malformed_capabilities = [
        (
            "ble-truncated-capability",
            capability[..23].to_vec(),
            "invalid_length",
        ),
        (
            "ble-capability-trailing-byte",
            appended(&capability, 0),
            "invalid_length",
        ),
        (
            "ble-capability-unknown-version",
            mutate(&capability, 0, 3),
            "unsupported_version",
        ),
        (
            "ble-capability-unknown-flag",
            mutate(&capability, 5, 1),
            "noncanonical_encoding",
        ),
        (
            "ble-capability-nonzero-reserved",
            mutate(&capability, 22, 1),
            "noncanonical_encoding",
        ),
    ];
    for (name, bytes, error) in malformed_capabilities {
        cases.push(error_case(
            name,
            "ble",
            "decodeCapabilities",
            &bytes,
            json!({}),
            error,
        ));
    }

    let begin = blob_begin(1, 0x0102_0304, 408, &authorization_digest);
    cases.push(error_case(
        "ble-truncated-blob-begin",
        "ble",
        "decodeSignedBlob",
        &begin[..41],
        json!({}),
        "invalid_length",
    ));
    cases.push(error_case(
        "ble-blob-nonzero-reserved",
        "ble",
        "decodeSignedBlob",
        &mutate(&begin, 3, 1),
        json!({}),
        "noncanonical_encoding",
    ));
    let out_of_order = blob_data(1, 0x0102_0304, 64, &documents.authorization[64..96])?;
    cases.push(error_case(
        "ble-blob-out-of-order-chunk",
        "ble",
        "decodeSignedBlob",
        &out_of_order,
        json!({ "assembledPrefixHex": "" }),
        "invalid_length",
    ));
    let conflicting = blob_data(1, 0x0102_0304, 0, &[0xff; 48])?;
    cases.push(error_case(
        "ble-blob-conflicting-duplicate",
        "ble",
        "decodeSignedBlob",
        &conflicting,
        json!({ "assembledPrefixHex": hex(&documents.authorization[..48]) }),
        "integrity_failed",
    ));

    let start = fresh_start(&documents.authorization, &prefix_empty);
    cases.push(error_case(
        "ble-trailing-start",
        "ble",
        "decodeTransfer",
        &appended(&start, 0),
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "invalid_length",
    ));
    cases.push(error_case(
        "ble-truncated-start",
        "ble",
        "decodeTransfer",
        &start[..127],
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "invalid_length",
    ));
    cases.push(error_case(
        "ble-nonzero-reserved",
        "ble",
        "decodeTransfer",
        &mutate(&abort_frame(), 14, 1),
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "noncanonical_encoding",
    ));
    cases.push(error_case(
        "ble-unknown-message",
        "ble",
        "decodeTransfer",
        &[0x7e],
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "unsupported_version",
    ));
    cases.push(error_case(
        "ble-unknown-version",
        "ble",
        "decodeTransfer",
        &mutate(&start, 1, 3),
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "unsupported_version",
    ));
    cases.push(error_case(
        "ble-unknown-flags",
        "ble",
        "decodeTransfer",
        &mutate(&start, 3, 0x80),
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "noncanonical_encoding",
    ));
    let repair = repair_window_ack(&prefix_first);
    let mut count_mismatch = repair.clone();
    count_mismatch[64..66].copy_from_slice(&3_u16.to_le_bytes());
    cases.push(error_case(
        "ble-window-count-mismatch",
        "ble",
        "decodeTransfer",
        &count_mismatch,
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "invalid_length",
    ));
    let data = data_frame(storage);
    let mut data_length_mismatch = data.clone();
    data_length_mismatch[24..26].copy_from_slice(&33_u16.to_le_bytes());
    cases.push(error_case(
        "ble-data-length-mismatch",
        "ble",
        "decodeTransfer",
        &data_length_mismatch,
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "invalid_length",
    ));
    let mut zero_session = start.clone();
    zero_session[4..12].fill(0);
    cases.push(error_case(
        "ble-zero-session",
        "ble",
        "decodeTransfer",
        &zero_session,
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "noncanonical_encoding",
    ));
    cases.push(error_case(
        "ble-wrong-session",
        "ble",
        "decodeTransfer",
        &start,
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID + 1 }),
        "session_mismatch",
    ));
    cases.push(error_case(
        "ble-recording-identity-mismatch",
        "ble",
        "decodeTransfer",
        &mutate(&start, 28, 1),
        json!({
            "expectedTransportSessionId": TRANSPORT_SESSION_ID,
            "expectedRecordingUuid": uuid(&RECORDING_UUID)
        }),
        "recording_identity_mismatch",
    ));
    cases.push(error_case(
        "ble-recording-generation-mismatch",
        "ble",
        "decodeTransfer",
        &mutate(&start, 44, 1),
        json!({
            "expectedTransportSessionId": TRANSPORT_SESSION_ID,
            "expectedRecordingGeneration": RECORDING_GENERATION
        }),
        "recording_identity_mismatch",
    ));
    let resume = resume_request(&prefix_first);
    cases.push(error_case(
        "ble-resume-prefix-rejected",
        "ble",
        "decodeTransfer",
        &mutate(&resume, 60, 1),
        json!({
            "expectedTransportSessionId": TRANSPORT_SESSION_ID,
            "assembledPrefixHex": hex(&storage.bytes[..64.min(storage.bytes.len())])
        }),
        "checkpoint_mismatch",
    ));
    let mut mixed = vec![0x01, 0x81];
    mixed.extend_from_slice(&start);
    cases.push(error_case(
        "ble-mixed-v1-p10-v2",
        "ble",
        "decodeTransfer",
        &mixed,
        json!({ "expectedTransportSessionId": TRANSPORT_SESSION_ID }),
        "mixed_profile",
    ));
    Ok(())
}

fn transfer_frames(
    storage: &StorageFixture,
    documents: &DocumentFixture,
    prefix_empty: &[u8; 32],
    prefix_first: &[u8; 32],
) -> Result<Vec<TransferFixture>, String> {
    let entry = recording_entry(storage);
    let list_digest = sha256(&entry[12..96]);
    let manifest_digest = sha256(&documents.manifest);
    Ok(vec![
        ("ble-list", "list", list_frame()),
        ("ble-recording-entry", "recordingEntry", entry),
        (
            "ble-recording-list-end",
            "recordingListEnd",
            recording_list_end(&list_digest),
        ),
        (
            "ble-fresh-transfer",
            "start",
            fresh_start(&documents.authorization, prefix_empty),
        ),
        (
            "ble-start-ack",
            "startAck",
            start_ack(storage, prefix_empty),
        ),
        ("ble-data", "data", data_frame(storage)),
        ("ble-window-end", "windowEnd", window_end(prefix_first)),
        (
            "ble-window-clean-ack",
            "windowAck",
            clean_window_ack(prefix_first),
        ),
        (
            "ble-window-repair",
            "windowAck",
            repair_window_ack(prefix_first),
        ),
        (
            "ble-manifest-chunk",
            "manifestChunk",
            manifest_chunk(&documents.manifest, &manifest_digest)?,
        ),
        ("ble-eof", "eof", eof_frame(storage, &manifest_digest)),
        (
            "ble-resume-request",
            "resumeRequest",
            resume_request(prefix_first),
        ),
        (
            "ble-resume-accepted",
            "resumeAccept",
            resume_accept(prefix_first),
        ),
        (
            "ble-resume-reject",
            "resumeReject",
            resume_reject(prefix_first),
        ),
        ("ble-confirm", "confirm", confirm_frame(&documents.receipt)),
        ("ble-abort", "abort", abort_frame()),
        ("ble-error", "error", error_frame()),
    ])
}

fn capability_value() -> [u8; 24] {
    let mut bytes = [0_u8; 24];
    bytes[0] = 1;
    bytes[1] = 2;
    put_u16(&mut bytes, 2, 24);
    put_u32(&mut bytes, 4, 0x7f);
    put_u16(&mut bytes, 8, 1024);
    put_u16(&mut bytes, 10, 1024);
    put_u16(&mut bytes, 12, 244);
    put_u16(&mut bytes, 14, 16);
    put_u32(&mut bytes, 16, 8);
    put_u16(&mut bytes, 20, 16);
    bytes
}

fn common_frame(message_type: u8, length: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; length];
    bytes[0] = message_type;
    bytes[1] = 2;
    put_u64(&mut bytes, 4, TRANSPORT_SESSION_ID);
    bytes
}

fn list_frame() -> Vec<u8> {
    common_frame(0x25, 16)
}

fn recording_entry(storage: &StorageFixture) -> Vec<u8> {
    let mut bytes = common_frame(0x48, 96);
    bytes[12..28].copy_from_slice(&RECORDING_UUID);
    put_u32(&mut bytes, 28, RECORDING_GENERATION);
    bytes[32] = 3;
    bytes[33] = 1;
    put_u64(&mut bytes, 36, 1_999_999_000);
    put_u32(&mut bytes, 44, 37);
    put_u64(&mut bytes, 48, storage.plaintext_length);
    put_u64(&mut bytes, 56, storage.bytes.len() as u64);
    bytes[64..96].copy_from_slice(&storage.ciphertext_sha256);
    bytes
}

fn recording_list_end(list_digest: &[u8; 32]) -> Vec<u8> {
    let mut bytes = common_frame(0x49, 52);
    put_u32(&mut bytes, 12, 1);
    put_u32(&mut bytes, 16, 17);
    bytes[20..52].copy_from_slice(list_digest);
    bytes
}

fn fresh_start(authorization: &[u8; 408], prefix_empty: &[u8; 32]) -> Vec<u8> {
    let mut bytes = common_frame(0x20, 128);
    bytes[12..28].copy_from_slice(&UPLOAD_SESSION_UUID);
    bytes[28..44].copy_from_slice(&RECORDING_UUID);
    put_u32(&mut bytes, 44, RECORDING_GENERATION);
    bytes[48..80].copy_from_slice(&sha256(authorization));
    bytes[92..124].copy_from_slice(prefix_empty);
    put_u16(&mut bytes, 124, 16);
    put_u16(&mut bytes, 126, 244);
    bytes
}

fn start_ack(storage: &StorageFixture, prefix_empty: &[u8; 32]) -> Vec<u8> {
    let mut bytes = common_frame(0x40, 140);
    bytes[12..28].copy_from_slice(&UPLOAD_SESSION_UUID);
    bytes[28..44].copy_from_slice(&RECORDING_UUID);
    put_u32(&mut bytes, 44, RECORDING_GENERATION);
    put_u64(&mut bytes, 48, storage.bytes.len() as u64);
    bytes[56..88].copy_from_slice(&storage.ciphertext_sha256);
    put_u16(&mut bytes, 88, 16);
    put_u16(&mut bytes, 90, 244);
    put_u32(&mut bytes, 92, 8);
    bytes[108..140].copy_from_slice(prefix_empty);
    bytes
}

fn data_frame(storage: &StorageFixture) -> Vec<u8> {
    let payload = &storage.bytes[..32.min(storage.bytes.len())];
    let mut bytes = common_frame(0x41, 28 + payload.len());
    put_u32(&mut bytes, 12, 1);
    put_u64(&mut bytes, 16, 0);
    put_u16(&mut bytes, 24, payload.len() as u16);
    bytes[28..].copy_from_slice(payload);
    bytes
}

fn window_end(prefix: &[u8; 32]) -> Vec<u8> {
    let mut bytes = common_frame(0x42, 68);
    put_u32(&mut bytes, 12, 2);
    put_u32(&mut bytes, 16, 1);
    put_u32(&mut bytes, 20, 16);
    put_u64(&mut bytes, 24, 64);
    bytes[32..64].copy_from_slice(prefix);
    put_u32(&mut bytes, 64, 4);
    bytes
}

fn clean_window_ack(prefix: &[u8; 32]) -> Vec<u8> {
    let mut bytes = common_frame(0x21, 68);
    put_u32(&mut bytes, 12, 2);
    put_u32(&mut bytes, 16, 16);
    put_u64(&mut bytes, 20, 64);
    bytes[28..60].copy_from_slice(prefix);
    put_u32(&mut bytes, 60, 4);
    bytes
}

fn repair_window_ack(prefix: &[u8; 32]) -> Vec<u8> {
    let mut bytes = common_frame(0x21, 76);
    put_u32(&mut bytes, 12, 2);
    put_u32(&mut bytes, 16, 12);
    put_u64(&mut bytes, 20, 48);
    bytes[28..60].copy_from_slice(prefix);
    put_u32(&mut bytes, 60, 3);
    put_u16(&mut bytes, 64, 2);
    put_u32(&mut bytes, 68, 13);
    put_u32(&mut bytes, 72, 15);
    bytes
}

fn manifest_chunk(manifest: &[u8; 580], digest: &[u8; 32]) -> Result<Vec<u8>, String> {
    let chunk = &manifest[..64];
    let mut bytes = common_frame(0x43, 52 + chunk.len());
    put_u16(&mut bytes, 12, 580);
    put_u16(&mut bytes, 14, 0);
    put_u16(
        &mut bytes,
        16,
        u16::try_from(chunk.len()).map_err(|_| "manifest chunk too large".to_owned())?,
    );
    bytes[20..52].copy_from_slice(digest);
    bytes[52..].copy_from_slice(chunk);
    Ok(bytes)
}

fn eof_frame(storage: &StorageFixture, manifest_digest: &[u8; 32]) -> Vec<u8> {
    let mut bytes = common_frame(0x44, 92);
    put_u32(&mut bytes, 12, 17);
    put_u32(&mut bytes, 16, storage.block_count);
    put_u64(&mut bytes, 20, storage.bytes.len() as u64);
    bytes[28..60].copy_from_slice(&storage.ciphertext_sha256);
    bytes[60..92].copy_from_slice(manifest_digest);
    bytes
}

fn resume_frame(code: u8, prefix: &[u8; 32]) -> Vec<u8> {
    let mut bytes = common_frame(code, 96);
    bytes[12..28].copy_from_slice(&UPLOAD_SESSION_UUID);
    bytes[28..44].copy_from_slice(&RECORDING_UUID);
    put_u32(&mut bytes, 44, RECORDING_GENERATION);
    put_u32(&mut bytes, 48, 3);
    put_u64(&mut bytes, 52, 64);
    bytes[60..92].copy_from_slice(prefix);
    put_u16(&mut bytes, 92, 16);
    put_u16(&mut bytes, 94, 244);
    bytes
}

fn resume_request(prefix: &[u8; 32]) -> Vec<u8> {
    resume_frame(0x22, prefix)
}

fn resume_accept(prefix: &[u8; 32]) -> Vec<u8> {
    resume_frame(0x45, prefix)
}

fn resume_reject(prefix: &[u8; 32]) -> Vec<u8> {
    let mut bytes = common_frame(0x46, 60);
    put_u16(&mut bytes, 12, 0x0f);
    put_u32(&mut bytes, 16, 3);
    put_u64(&mut bytes, 20, 64);
    bytes[28..60].copy_from_slice(prefix);
    bytes
}

fn confirm_frame(receipt: &[u8; 336]) -> Vec<u8> {
    let mut bytes = common_frame(0x23, 84);
    bytes[12..28].copy_from_slice(&UPLOAD_SESSION_UUID);
    bytes[28..44].copy_from_slice(&RECORDING_UUID);
    put_u32(&mut bytes, 44, RECORDING_GENERATION);
    put_u32(&mut bytes, 48, OWNER_REVISION);
    bytes[52..84].copy_from_slice(&sha256(receipt));
    bytes
}

fn abort_frame() -> Vec<u8> {
    let mut bytes = common_frame(0x24, 16);
    put_u16(&mut bytes, 12, 0x0e);
    bytes
}

fn error_frame() -> Vec<u8> {
    let mut bytes = common_frame(0x4f, 20);
    put_u16(&mut bytes, 12, 0x0f);
    bytes[14] = 0x22;
    put_u32(&mut bytes, 16, 3);
    bytes
}

fn status_value() -> [u8; 24] {
    let mut bytes = [0_u8; 24];
    bytes[0] = 2;
    bytes[1] = 3;
    put_u64(&mut bytes, 4, TRANSPORT_SESSION_ID);
    put_u64(&mut bytes, 12, 64);
    bytes[20] = 37;
    bytes[21] = 3;
    bytes
}

fn blob_begin(kind: u8, write_id: u32, total_length: u16, digest: &[u8; 32]) -> Vec<u8> {
    let mut bytes = vec![0_u8; 42];
    bytes[0] = 0x60;
    bytes[1] = 2;
    bytes[2] = kind;
    put_u32(&mut bytes, 4, write_id);
    put_u16(&mut bytes, 8, total_length);
    bytes[10..42].copy_from_slice(digest);
    bytes
}

fn blob_data(kind: u8, write_id: u32, offset: u16, data: &[u8]) -> Result<Vec<u8>, String> {
    let length = u16::try_from(data.len()).map_err(|_| "blob chunk too large".to_owned())?;
    let mut bytes = vec![0_u8; 12 + data.len()];
    bytes[0] = 0x61;
    bytes[1] = 2;
    bytes[2] = kind;
    put_u32(&mut bytes, 4, write_id);
    put_u16(&mut bytes, 8, offset);
    put_u16(&mut bytes, 10, length);
    bytes[12..].copy_from_slice(data);
    Ok(bytes)
}

fn blob_simple(code: u8, kind: u8, write_id: u32) -> Vec<u8> {
    let mut bytes = vec![0_u8; 8];
    bytes[0] = code;
    bytes[1] = 2;
    bytes[2] = kind;
    put_u32(&mut bytes, 4, write_id);
    bytes
}

fn blob_result(kind: u8, write_id: u32, result: u16) -> Vec<u8> {
    let mut bytes = blob_simple(0x64, kind, write_id);
    bytes.resize(10, 0);
    put_u16(&mut bytes, 8, result);
    bytes
}

fn add_compatibility_cases(cases: &mut Vec<VectorCase>) {
    let traces = [
        (
            "old-sdk-old-firmware-v1",
            json!({
                "sdkGeneration": "old", "firmwareGeneration": "old",
                "backendPolicy": "legacy_allowed", "entryPoint": "batch",
                "capabilityRead": false, "capabilityBatch": false,
                "requestedProfile": "legacy_plain_v1"
            }),
            json!({
                "accepted": true, "selectedProfile": "legacy_plain_v1",
                "emittedPacketProfile": "legacy_plain_v1", "relayRoute": "presigned_s3"
            }),
        ),
        (
            "new-sdk-old-firmware-v1",
            json!({
                "sdkGeneration": "new", "firmwareGeneration": "old",
                "backendPolicy": "legacy_allowed", "entryPoint": "batch",
                "capabilityRead": true, "capabilityBatch": false,
                "requestedProfile": "legacy_plain_v1"
            }),
            json!({
                "accepted": true, "selectedProfile": "legacy_plain_v1",
                "emittedPacketProfile": "legacy_plain_v1", "relayRoute": "presigned_s3"
            }),
        ),
        (
            "old-sdk-new-firmware-v1",
            json!({
                "sdkGeneration": "old", "firmwareGeneration": "new",
                "backendPolicy": "legacy_allowed", "entryPoint": "batch",
                "capabilityRead": false, "capabilityBatch": true,
                "requestedProfile": "legacy_plain_v1"
            }),
            json!({
                "accepted": true, "selectedProfile": "legacy_plain_v1",
                "emittedPacketProfile": "legacy_plain_v1", "relayRoute": "presigned_s3"
            }),
        ),
        (
            "new-sdk-new-firmware-v2-after-capability",
            json!({
                "sdkGeneration": "new", "firmwareGeneration": "new",
                "backendPolicy": "v2_preferred", "entryPoint": "batch",
                "capabilityRead": true, "capabilityBatch": true,
                "requestedProfile": "encrypted_upload_v2"
            }),
            json!({
                "accepted": true, "selectedProfile": "encrypted_upload_v2",
                "emittedPacketProfile": "encrypted_upload_v2", "relayRoute": "ciphertext_staging"
            }),
        ),
        (
            "historical-p10-unchanged",
            json!({
                "sdkGeneration": "old", "firmwareGeneration": "p10",
                "backendPolicy": "legacy_allowed", "entryPoint": "batch",
                "capabilityRead": false, "capabilityBatch": false,
                "requestedProfile": "legacy_p10_relay"
            }),
            json!({
                "accepted": true, "selectedProfile": "legacy_p10_relay",
                "emittedPacketProfile": "legacy_p10_relay", "relayRoute": "upload_relay"
            }),
        ),
    ];
    for (name, context, expected) in traces {
        cases.push(valid_case(
            name,
            "compatibility",
            "runCompatibilityTrace",
            &[],
            context,
            expected,
        ));
    }
    for (name, entry_point) in [
        ("v2-required-rejects-legacy-batch", "batch"),
        ("v2-required-rejects-legacy-streaming", "streaming"),
    ] {
        cases.push(error_case(
            name,
            "compatibility",
            "runCompatibilityTrace",
            &[],
            json!({
                "sdkGeneration": "old", "firmwareGeneration": "new",
                "backendPolicy": "v2_required", "entryPoint": entry_point,
                "capabilityRead": false, "capabilityBatch": true,
                "requestedProfile": "legacy_plain_v1"
            }),
            "downgrade_prohibited",
        ));
    }
}

fn valid_case(
    name: &str,
    category: &'static str,
    operation: &'static str,
    input: &[u8],
    context: Value,
    expected: Value,
) -> VectorCase {
    VectorCase {
        name: name.to_owned(),
        category,
        operation,
        input_hex: hex(input),
        context,
        expected: Some(expected),
        expected_error: None,
    }
}

fn error_case(
    name: &str,
    category: &'static str,
    operation: &'static str,
    input: &[u8],
    context: Value,
    expected_error: &'static str,
) -> VectorCase {
    VectorCase {
        name: name.to_owned(),
        category,
        operation,
        input_hex: hex(input),
        context,
        expected: None,
        expected_error: Some(expected_error),
    }
}

fn signing_key() -> Result<SigningKey, String> {
    SigningKey::from_bytes((&BACKEND_P256_SIGNING_KEY).into())
        .map_err(|error| format!("invalid fixed P-256 signing key: {error}"))
}

fn hpke_private_key() -> Result<<HpkeKem as KemTrait>::PrivateKey, String> {
    <HpkeKem as KemTrait>::PrivateKey::from_bytes(&HPKE_RECIPIENT_PRIVATE_KEY)
        .map_err(|_| "invalid fixed HPKE recipient private key".to_owned())
}

fn p256_spki_der(verifying_key: &VerifyingKey) -> Vec<u8> {
    const P256_SPKI_PREFIX: &[u8] = &[
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
        0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ];
    let point = verifying_key.to_sec1_point(false);
    let mut der = P256_SPKI_PREFIX.to_vec();
    der.extend_from_slice(point.as_bytes());
    der
}

fn sign_low_s(signing_key: &SigningKey, message: &[u8]) -> Result<[u8; 64], String> {
    let digest = sha256(message);
    let signature: Signature = signing_key
        .sign_prehash(&digest)
        .map_err(|error| format!("P-256 signing failed: {error}"))?;
    let normalized = signature.normalize_s();
    Ok(normalized.to_bytes().into())
}

fn verify_low_s(
    verifying_key: &VerifyingKey,
    message: &[u8],
    signature_bytes: &[u8],
) -> Result<(), String> {
    let signature =
        Signature::from_slice(signature_bytes).map_err(|_| "signature_invalid".to_owned())?;
    if signature.normalize_s() != signature {
        return Err("signature_invalid".to_owned());
    }
    verifying_key
        .verify_prehash(&sha256(message), &signature)
        .map_err(|_| "signature_invalid".to_owned())
}

fn to_high_s(signature: &[u8]) -> Result<[u8; 64], String> {
    if signature.len() != 64 {
        return Err("P1363 signature must be 64 bytes".to_owned());
    }
    const P256_ORDER: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63,
        0x25, 0x51,
    ];
    let mut high_s = [0_u8; 32];
    let mut borrow = 0_u16;
    for index in (0..32).rev() {
        let minuend = u16::from(P256_ORDER[index]);
        let subtrahend = u16::from(signature[32 + index]) + borrow;
        if minuend >= subtrahend {
            high_s[index] = (minuend - subtrahend) as u8;
            borrow = 0;
        } else {
            high_s[index] = (256 + minuend - subtrahend) as u8;
            borrow = 1;
        }
    }
    if borrow != 0 {
        return Err("signature scalar exceeds P-256 order".to_owned());
    }
    let mut result = [0_u8; 64];
    result[..32].copy_from_slice(&signature[..32]);
    result[32..].copy_from_slice(&high_s);
    Ok(result)
}

fn seal_chacha(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<(Vec<u8>, [u8; 16]), String> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let mut ciphertext = plaintext.to_vec();
    let tag = cipher
        .encrypt_inout_detached(nonce.into(), aad, InOutBuf::from(ciphertext.as_mut_slice()))
        .map_err(|_| "ChaCha20-Poly1305 seal failed".to_owned())?;
    Ok((ciphertext, tag.into()))
}

fn open_chacha(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    ciphertext: &[u8],
    tag: &[u8; 16],
) -> Result<Vec<u8>, String> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let mut plaintext = ciphertext.to_vec();
    cipher
        .decrypt_inout_detached(
            nonce.into(),
            aad,
            InOutBuf::from(plaintext.as_mut_slice()),
            tag.into(),
        )
        .map_err(|_| "authentication_failed".to_owned())?;
    Ok(plaintext)
}

fn hkdf_sha256(salt: &[u8], ikm: &[u8], info: &[u8], length: usize) -> Result<Vec<u8>, String> {
    if length > 255 * 32 {
        return Err("HKDF output length exceeds RFC 5869".to_owned());
    }
    let effective_salt = if salt.is_empty() {
        &[0_u8; 32][..]
    } else {
        salt
    };
    let prk = hmac_sha256(effective_salt, ikm)?;
    let mut output = Vec::with_capacity(length);
    let mut previous = Vec::new();
    let blocks = length.div_ceil(32);
    for block_index in 1..=blocks {
        let mut input = previous;
        input.extend_from_slice(info);
        input.push(u8::try_from(block_index).map_err(|_| "HKDF block overflow".to_owned())?);
        previous = hmac_sha256(&prk, &input)?.to_vec();
        output.extend_from_slice(&previous);
    }
    output.truncate(length);
    Ok(output)
}

fn hmac_sha256(key: &[u8], input: &[u8]) -> Result<[u8; 32], String> {
    let mut mac = <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(key)
        .map_err(|_| "invalid HMAC key".to_owned())?;
    mac.update(input);
    Ok(mac.finalize().into_bytes().into())
}

fn block_nonce(base: &[u8; 12], block_index: u32) -> [u8; 12] {
    let mut nonce = *base;
    for (target, index_byte) in nonce[8..12].iter_mut().zip(block_index.to_le_bytes()) {
        *target ^= index_byte;
    }
    nonce
}

fn block_aad(block_index: u32, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    let mut aad = DOMAIN_BLOCK_AAD.to_vec();
    aad.extend_from_slice(&2_u16.to_le_bytes());
    aad.extend_from_slice(&RECORDING_UUID);
    aad.extend_from_slice(&RECORDING_GENERATION.to_le_bytes());
    aad.extend_from_slice(&block_index.to_le_bytes());
    aad.extend_from_slice(&offset.to_le_bytes());
    aad.extend_from_slice(
        &u32::try_from(length)
            .map_err(|_| "block length exceeds u32".to_owned())?
            .to_le_bytes(),
    );
    Ok(aad)
}

fn recording_salt() -> [u8; 20] {
    let mut salt = [0_u8; 20];
    salt[..16].copy_from_slice(&RECORDING_UUID);
    salt[16..].copy_from_slice(&RECORDING_GENERATION.to_le_bytes());
    salt
}

fn digest_lp(domain: &[u8], fields: &[&[u8]]) -> Result<[u8; 32], String> {
    let mut bytes = domain.to_vec();
    for field in fields {
        append_lp(&mut bytes, field)?;
    }
    Ok(sha256(&bytes))
}

fn append_lp(output: &mut Vec<u8>, value: &[u8]) -> Result<(), String> {
    let length =
        u16::try_from(value.len()).map_err(|_| "length-prefixed value exceeds u16".to_owned())?;
    output.extend_from_slice(&length.to_le_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn require_document(bytes: &[u8], length: usize, magic: &[u8; 8]) -> Result<(), String> {
    if bytes.len() != length {
        return Err("invalid_length".to_owned());
    }
    if &bytes[..8] != magic {
        return Err("invalid_magic".to_owned());
    }
    if read_u16(bytes, 8)? != 2 {
        return Err("unsupported_version".to_owned());
    }
    if usize::from(read_u16(bytes, 10)?) != length {
        return Err("invalid_length".to_owned());
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn sha256_concat(parts: &[&[u8]]) -> [u8; 32] {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part);
    }
    digest.finalize().into()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn mutate(bytes: &[u8], index: usize, mask: u8) -> Vec<u8> {
    let mut result = bytes.to_vec();
    result[index] ^= mask;
    result
}

fn appended(bytes: &[u8], byte: u8) -> Vec<u8> {
    let mut result = bytes.to_vec();
    result.push(byte);
    result
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| "invalid_length".to_owned())?;
    let value = bytes
        .get(offset..end)
        .ok_or_else(|| "invalid_length".to_owned())?;
    Ok(u16::from_le_bytes(
        value.try_into().expect("two-byte slice"),
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| "invalid_length".to_owned())?;
    let value = bytes
        .get(offset..end)
        .ok_or_else(|| "invalid_length".to_owned())?;
    Ok(u32::from_le_bytes(
        value.try_into().expect("four-byte slice"),
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| "invalid_length".to_owned())?;
    let value = bytes
        .get(offset..end)
        .ok_or_else(|| "invalid_length".to_owned())?;
    Ok(u64::from_le_bytes(
        value.try_into().expect("eight-byte slice"),
    ))
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn uuid(bytes: &[u8; 16]) -> String {
    let encoded = hex(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &encoded[0..8],
        &encoded[8..12],
        &encoded[12..16],
        &encoded[16..20],
        &encoded[20..32]
    )
}
