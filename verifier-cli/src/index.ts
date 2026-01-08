/**
 * BioPassport Verifier Module
 */

export { MaterialVerifier, createVerifier } from './verifier';
export type {
  VerifierConfig,
  Material,
  Credential,
  TransferEvent,
  VerificationResult,
  VerificationCheck,
  CredentialSummary,
  TransferChainResult,
  ArtifactIntegrityResult
} from './verifier';
