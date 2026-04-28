# ESP32-S3 + ATECC608B Setup

The Node.js edge-node is the first green implementation for IoT-J measurements. The constrained-device port is planned for the next phase.

## Target Design

Use the ATECC608B secure element to hold the device-bound ECDSA key. The ESP32 firmware should:

1. Hash the raw instrument result with SHA-256.
2. Build the same ABI-encoded attestation digest as `BioPassportRegistry.attestationHash`.
3. Request an ECDSA signature from the secure element.
4. Submit the signed attestation to the issuer service over mTLS.

The on-chain registry remains unchanged because it verifies standard secp256k1 Ethereum signatures.
