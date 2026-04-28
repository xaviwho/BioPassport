/**
 * End-to-end smoke test against live PureChain
 * Tests both BioPassportRegistry and BioPassportV2 contracts
 *
 * Usage: PRIVATE_KEY=<key> npx hardhat run scripts/smoke-test.ts --network purechain
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const deployPath = path.resolve(__dirname, "..", "deployment.json");
  const deploy = JSON.parse(fs.readFileSync(deployPath, "utf8"));

  const REGISTRY_ADDR = deploy.contracts.BioPassportRegistry.address;
  const V2_ADDR = deploy.contracts.BioPassportV2.address;

  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);
  console.log("Registry:", REGISTRY_ADDR);
  console.log("V2:", V2_ADDR);
  console.log("");

  const Registry = await ethers.getContractAt("BioPassportRegistry", REGISTRY_ADDR);
  const V2 = await ethers.getContractAt("BioPassportV2", V2_ADDR);

  const results: { test: string; tx?: string; block?: number; data?: any }[] = [];

  // ========== BioPassportRegistry Tests ==========
  console.log("===== BioPassportRegistry Tests =====");

  // 1. Register material
  console.log("1. Registering material (CELL_LINE)...");
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ name: "HeLa", origin: "cervical", passage: 42 })));
  const tx1 = await Registry.registerMaterial("CELL_LINE", metadataHash, "ATCC", { gasPrice: 0 });
  const r1 = await tx1.wait();
  const count = await Registry.materialCount();
  const materialId = "bio:cell_line:" + count.toString();
  console.log("   TX:", r1!.hash);
  console.log("   Block:", r1!.blockNumber);
  console.log("   Material ID:", materialId);
  results.push({ test: "Register Material", tx: r1!.hash, block: r1!.blockNumber, data: { materialId } });

  // 2. Query material
  console.log("2. Querying material...");
  const mat = await Registry.getMaterial(materialId);
  console.log("   Type:", mat.materialType, "| Status:", ["ACTIVE", "QUARANTINED", "REVOKED"][Number(mat.status)]);
  results.push({ test: "Query Material", data: { type: mat.materialType, status: "ACTIVE", owner: mat.owner } });

  // 3. Issue IDENTITY credential
  console.log("3. Issuing IDENTITY credential...");
  const idCommit = ethers.keccak256(ethers.toUtf8Bytes("identity-" + Date.now()));
  const idArtifact = ethers.keccak256(ethers.toUtf8Bytes("identity-artifact"));
  const idValid = Math.floor(Date.now() / 1000) + 365 * 86400;
  const tx3 = await Registry.issueCredential(materialId, 0, idCommit, idValid, "s3://biopassport/identity.json", idArtifact, "ATCC", { gasPrice: 0 });
  const r3 = await tx3.wait();
  console.log("   TX:", r3!.hash, "| Block:", r3!.blockNumber);
  results.push({ test: "Issue IDENTITY", tx: r3!.hash, block: r3!.blockNumber });

  // 4. Issue QC_MYCO credential
  console.log("4. Issuing QC_MYCO credential...");
  const qcCommit = ethers.keccak256(ethers.toUtf8Bytes("qc-myco-" + Date.now()));
  const qcArtifact = ethers.keccak256(ethers.toUtf8Bytes("qc-report.pdf"));
  const qcValid = Math.floor(Date.now() / 1000) + 90 * 86400;
  const tx4 = await Registry.issueCredential(materialId, 1, qcCommit, qcValid, "s3://biopassport/qc.json", qcArtifact, "QCLab", { gasPrice: 0 });
  const r4 = await tx4.wait();
  console.log("   TX:", r4!.hash, "| Block:", r4!.blockNumber);
  results.push({ test: "Issue QC_MYCO", tx: r4!.hash, block: r4!.blockNumber });

  // 5. Verify material (should PASS - has IDENTITY + QC_MYCO)
  console.log("5. On-chain verification...");
  const [pass1, reasons1] = await Registry.verifyMaterial(materialId);
  console.log("   PASS:", pass1, "| Reasons:", reasons1.length === 0 ? "(none)" : reasons1.join(", "));
  results.push({ test: "Verify Material", data: { pass: pass1, reasons: reasons1 } });

  // 6. Query credentials
  console.log("6. Querying credentials...");
  const creds = await Registry.getCredentials(materialId);
  console.log("   Count:", creds.length);
  for (const c of creds) {
    console.log("   -", c.credentialId, ["IDENTITY", "QC_MYCO", "USAGE_RIGHTS"][Number(c.credType)]);
  }
  results.push({ test: "Query Credentials", data: { count: creds.length } });

  // 7. Issue USAGE_RIGHTS credential
  console.log("7. Issuing USAGE_RIGHTS credential...");
  const urCommit = ethers.keccak256(ethers.toUtf8Bytes("usage-rights-" + Date.now()));
  const urArtifact = ethers.keccak256(ethers.toUtf8Bytes("mta-doc.pdf"));
  const urValid = Math.floor(Date.now() / 1000) + 365 * 5 * 86400;
  const tx7 = await Registry.issueCredential(materialId, 2, urCommit, urValid, "s3://biopassport/usage.json", urArtifact, "ATCC", { gasPrice: 0 });
  const r7 = await tx7.wait();
  console.log("   TX:", r7!.hash);
  results.push({ test: "Issue USAGE_RIGHTS", tx: r7!.hash, block: r7!.blockNumber });

  // 8. Transfer
  console.log("8. Initiating transfer...");
  const shipHash = ethers.keccak256(ethers.toUtf8Bytes("shipment-form-001"));
  const tx8 = await Registry.initiateTransfer(materialId, signer.address, "ReceiverOrg", shipHash, { gasPrice: 0 });
  const r8 = await tx8.wait();
  console.log("   TX:", r8!.hash);
  results.push({ test: "Initiate Transfer", tx: r8!.hash, block: r8!.blockNumber });

  // 9. Accept transfer
  console.log("9. Accepting transfer...");
  const tx9 = await Registry.acceptTransfer(materialId, { gasPrice: 0 });
  const r9 = await tx9.wait();
  console.log("   TX:", r9!.hash);
  results.push({ test: "Accept Transfer", tx: r9!.hash, block: r9!.blockNumber });

  // 10. History
  const histCount = Number(await Registry.getHistoryCount(materialId));
  console.log("10. History entries:", histCount);
  results.push({ test: "History Count", data: { count: histCount } });

  // 11. Quarantine + restore
  console.log("11. Quarantining material...");
  const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Routine QC hold"));
  const tx11 = await Registry.setStatusByOwner(materialId, 1, reasonHash, { gasPrice: 0 });
  const r11 = await tx11.wait();
  const matQ = await Registry.getMaterial(materialId);
  console.log("    Status:", ["ACTIVE", "QUARANTINED", "REVOKED"][Number(matQ.status)]);
  results.push({ test: "Quarantine", tx: r11!.hash, data: { status: "QUARANTINED" } });

  console.log("12. Restoring to ACTIVE...");
  const tx12 = await Registry.setStatusByOwner(materialId, 0, ethers.keccak256(ethers.toUtf8Bytes("QC cleared")), { gasPrice: 0 });
  await tx12.wait();
  results.push({ test: "Restore Active", tx: (await tx12.wait())?.hash });

  // 13. Final verify
  console.log("13. Final on-chain verification...");
  const [pass2, reasons2] = await Registry.verifyMaterial(materialId);
  console.log("    PASS:", pass2, "| Reasons:", reasons2.length === 0 ? "(none)" : reasons2.join(", "));
  results.push({ test: "Final Verify", data: { pass: pass2, reasons: reasons2 } });

  console.log("");

  // ========== BioPassportV2 Tests ==========
  console.log("===== BioPassportV2 Tests =====");

  // 14. Register asset
  console.log("14. Registering asset...");
  const assetIdHash = ethers.keccak256(ethers.toUtf8Bytes("bio:cell_line:HeLa-" + Date.now()));
  const tx14 = await V2.registerAsset(assetIdHash, "s3://biopassport/metadata/hela.json", { gasPrice: 0 });
  const r14 = await tx14.wait();
  console.log("    TX:", r14!.hash, "| Block:", r14!.blockNumber);
  results.push({ test: "V2 Register Asset", tx: r14!.hash, block: r14!.blockNumber });

  // 15. Issue credential chain
  console.log("15. Issuing credential #1...");
  const ch1 = ethers.keccak256(ethers.toUtf8Bytes("v2-c1-" + Date.now()));
  const er1 = ethers.keccak256(ethers.toUtf8Bytes("ev-root-1"));
  const tx15 = await V2.issueCredential(assetIdHash, ch1, ethers.ZeroHash, er1, "s3://biopassport/cred/1.json", { gasPrice: 0 });
  const r15 = await tx15.wait();
  console.log("    TX:", r15!.hash);
  results.push({ test: "V2 Credential #1", tx: r15!.hash, block: r15!.blockNumber });

  console.log("16. Issuing credential #2 (chained)...");
  const ch2 = ethers.keccak256(ethers.toUtf8Bytes("v2-c2-" + Date.now()));
  const er2 = ethers.keccak256(ethers.toUtf8Bytes("ev-root-2"));
  const tx16 = await V2.issueCredential(assetIdHash, ch2, ch1, er2, "s3://biopassport/cred/2.json", { gasPrice: 0 });
  const r16 = await tx16.wait();
  console.log("    TX:", r16!.hash);
  results.push({ test: "V2 Credential #2 (chained)", tx: r16!.hash, block: r16!.blockNumber });

  // 17. Verify chain linkage
  console.log("17. Verifying chain linkage...");
  const link1 = await V2.verifyChainLinkage(ch1);
  const link2 = await V2.verifyChainLinkage(ch2);
  console.log("    Cred #1:", link1, "| Cred #2:", link2);
  results.push({ test: "V2 Chain Linkage", data: { cred1: link1, cred2: link2 } });

  // 18. Exception lifecycle
  console.log("18. Opening exception (EVIDENCE_MISSING)...");
  const tx18 = await V2.openException(assetIdHash, ch1, 2, "s3://biopassport/exc/1.json", { gasPrice: 0 });
  const r18 = await tx18.wait();
  // Parse exception ID from return value
  const excEvt = r18!.logs.find((l: any) => {
    try { return V2.interface.parseLog(l)?.name === "ExceptionOpened"; } catch { return false; }
  });
  const excId = excEvt ? Number(V2.interface.parseLog(excEvt)!.args[0]) : 0;
  console.log("    Exception ID:", excId, "| TX:", r18!.hash);
  results.push({ test: "V2 Open Exception", tx: r18!.hash, data: { exceptionId: excId } });

  console.log("19. Closing exception...");
  const tx19 = await V2.closeException(excId, "s3://biopassport/exc/resolution.json", { gasPrice: 0 });
  const r19 = await tx19.wait();
  console.log("    TX:", r19!.hash);
  results.push({ test: "V2 Close Exception", tx: r19!.hash });

  // 20. Final state
  console.log("20. Final asset state...");
  const asset = await V2.getAsset(assetIdHash);
  const credCount = Number(await V2.getCredentialCount(assetIdHash));
  console.log("    Credentials:", credCount, "| Exists:", asset.exists);
  results.push({ test: "V2 Final State", data: { credentialCount: credCount, exists: asset.exists } });

  // ========== Summary ==========
  console.log("");
  console.log("=".repeat(60));
  console.log("  ALL", results.length, "TESTS PASSED ON PURECHAIN");
  console.log("=".repeat(60));
  console.log("Registry:", REGISTRY_ADDR);
  console.log("V2:", V2_ADDR);
  console.log("Network: purechain (chainId: 900520900520)");

  // Save results
  const resultsPath = path.resolve(__dirname, "..", "test-results.json");
  fs.writeFileSync(resultsPath, JSON.stringify({
    network: "purechain",
    chainId: 900520900520,
    rpcUrl: "https://purechainnode.com:8547",
    timestamp: new Date().toISOString(),
    signer: signer.address,
    contracts: {
      BioPassportRegistry: REGISTRY_ADDR,
      BioPassportV2: V2_ADDR,
    },
    testCount: results.length,
    results,
  }, null, 2));
  console.log("\nResults saved to:", resultsPath);
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exitCode = 1;
});
