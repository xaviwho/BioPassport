/**
 * Deploy BioPassportRegistry contract to PureChain.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-registry.ts --network purechain
 *   npx hardhat run scripts/deploy-registry.ts --network hardhat
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log(`Deploying BioPassportRegistry to ${network.name}...\n`);

  const [deployer] = await ethers.getSigners();
  const txOverrides = network.name === "purechain" ? { gasPrice: 0 } : {};
  console.log("Deployer:", deployer.address);

  const chain = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Chain ID:", chain.chainId.toString());
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  const BioPassportRegistry = await ethers.getContractFactory("BioPassportRegistry");
  const contract = await BioPassportRegistry.deploy(txOverrides);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\nBioPassportRegistry deployed to:", address);

  const ADMIN_ROLE = await contract.DEFAULT_ADMIN_ROLE();
  const REGISTRAR_ROLE = await contract.REGISTRAR_ROLE();
  const AUDITOR_ROLE = await contract.AUDITOR_ROLE();
  const ISSUER_MANAGER_ROLE = await contract.ISSUER_MANAGER_ROLE();
  const DEVICE_MANAGER_ROLE = await contract.DEVICE_MANAGER_ROLE();

  console.log("\nRoles:");
  console.log("  ADMIN_ROLE:", ADMIN_ROLE);
  console.log("  REGISTRAR_ROLE:", REGISTRAR_ROLE);
  console.log("  AUDITOR_ROLE:", AUDITOR_ROLE);
  console.log("  ISSUER_MANAGER_ROLE:", ISSUER_MANAGER_ROLE);
  console.log("  DEVICE_MANAGER_ROLE:", DEVICE_MANAGER_ROLE);
  console.log("  Deployer has ADMIN:", await contract.hasRole(ADMIN_ROLE, deployer.address));
  console.log("  Deployer has REGISTRAR:", await contract.hasRole(REGISTRAR_ROLE, deployer.address));
  console.log("  Deployer has AUDITOR:", await contract.hasRole(AUDITOR_ROLE, deployer.address));
  console.log("  Deployer has ISSUER_MANAGER:", await contract.hasRole(ISSUER_MANAGER_ROLE, deployer.address));
  console.log("  Deployer has DEVICE_MANAGER:", await contract.hasRole(DEVICE_MANAGER_ROLE, deployer.address));

  const issuerPerm = await contract.issuerPermissions(deployer.address);
  console.log("\nIssuer Permissions (deployer):");
  console.log("  isApproved:", issuerPerm.isApproved);
  console.log("  canIssueIdentity:", issuerPerm.canIssueIdentity);
  console.log("  canIssueQC:", issuerPerm.canIssueQC);
  console.log("  canIssueUsageRights:", issuerPerm.canIssueUsageRights);

  console.log("\nRunning smoke test...");
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("test-metadata"));
  const tx = await contract.registerMaterial("CELL_LINE", metadataHash, "TestOrg", txOverrides);
  const receipt = await tx.wait();

  const iface = contract.interface;
  const materialEvent = receipt?.logs
    .map((log: any) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === "MaterialRegistered");

  if (materialEvent) {
    console.log("  Tx hash:", receipt?.hash);
  }

  const materialId = `bio:cell_line:${await contract.materialCount()}`;
  console.log("  Material registered:", materialId);
  const material = await contract.getMaterial(materialId);
  console.log("  Material type:", material.materialType);
  console.log("  Material status:", material.status === 0n ? "ACTIVE" : "OTHER");
  console.log("  Owner org:", material.ownerOrg);

  const deployInfo = {
    network: {
      name: network.name,
      chainId: Number(chain.chainId),
      rpcUrl: process.env.RPC_URL || process.env.PURECHAIN_RPC_URL || "https://purechainnode.com:8547",
    },
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      BioPassportRegistry: {
        address,
        description: "Full credential lifecycle with edge attestation",
      },
    },
  };
  const deployPath = path.resolve(__dirname, "..", "deployment.registry.json");
  fs.writeFileSync(deployPath, JSON.stringify(deployInfo, null, 2));
  console.log("  Deployment info saved:", deployPath);

  console.log("\nDeployment and smoke test complete.");
  console.log("\n--- Add these to your .env files ---");
  console.log(`CONTRACT_ADDRESS=${address}`);
  console.log(`BIOPASSPORT_CONTRACT_ADDRESS=${address}`);
  console.log(`CHAIN_ID=${chain.chainId.toString()}`);
  console.log(`RPC_URL=${process.env.RPC_URL || process.env.PURECHAIN_RPC_URL || "https://purechainnode.com:8547"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
