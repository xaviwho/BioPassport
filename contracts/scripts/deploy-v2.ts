/**
 * Deploy BioPassportV2 contract
 */

import { ethers } from "hardhat";

async function main() {
  console.log("Deploying BioPassportV2...");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const BioPassportV2 = await ethers.getContractFactory("BioPassportV2");
  const contract = await BioPassportV2.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("BioPassportV2 deployed to:", address);

  // Grant roles to deployer (already done in constructor, but explicit)
  const ISSUER_ROLE = await contract.ISSUER_ROLE();
  const AUDITOR_ROLE = await contract.AUDITOR_ROLE();
  
  console.log("\nRoles:");
  console.log("  ISSUER_ROLE:", ISSUER_ROLE);
  console.log("  AUDITOR_ROLE:", AUDITOR_ROLE);
  console.log("  Deployer has ISSUER_ROLE:", await contract.hasRole(ISSUER_ROLE, deployer.address));
  console.log("  Deployer has AUDITOR_ROLE:", await contract.hasRole(AUDITOR_ROLE, deployer.address));

  console.log("\n✅ Deployment complete!");
  console.log("\nAdd to .env:");
  console.log(`CONTRACT_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
