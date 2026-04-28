/**
 * Deploy both BioPassport contracts to PureChain
 *
 * BioPassportRegistry: Full credential lifecycle (issuer-service, verifier-cli)
 * BioPassportV2: Event-driven audit trail (services API, indexer, audit-pack)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-all.ts --network purechain
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("=".repeat(60));
  console.log("  BioPassport Full Deployment to PureChain");
  console.log("=".repeat(60));

  const [deployer] = await ethers.getSigners();
  console.log("\nDeployer:", deployer.address);

  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name, `(chainId: ${network.chainId})`);

  // --- Deploy BioPassportRegistry ---
  console.log("\n--- Deploying BioPassportRegistry ---");
  const Registry = await ethers.getContractFactory("BioPassportRegistry");
  const registry = await Registry.deploy({ gasPrice: 0 });
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("BioPassportRegistry:", registryAddress);

  // --- Deploy BioPassportV2 ---
  console.log("\n--- Deploying BioPassportV2 ---");
  const V2 = await ethers.getContractFactory("BioPassportV2");
  const v2 = await V2.deploy({ gasPrice: 0 });
  await v2.waitForDeployment();
  const v2Address = await v2.getAddress();
  console.log("BioPassportV2:", v2Address);

  // --- Write deployment info ---
  const deployInfo = {
    network: {
      name: network.name,
      chainId: Number(network.chainId),
      rpcUrl: process.env.PURECHAIN_RPC_URL || "https://purechainnode.com:8547",
    },
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      BioPassportRegistry: {
        address: registryAddress,
        description: "Full credential lifecycle (issuer-service, verifier-cli)",
      },
      BioPassportV2: {
        address: v2Address,
        description: "Event-driven audit trail (services API, indexer, audit-pack)",
      },
    },
  };

  const deployPath = path.resolve(__dirname, "..", "deployment.json");
  fs.writeFileSync(deployPath, JSON.stringify(deployInfo, null, 2));
  console.log("\nDeployment info saved to:", deployPath);

  // --- Generate .env snippet ---
  console.log("\n" + "=".repeat(60));
  console.log("  Add to your .env files:");
  console.log("=".repeat(60));
  console.log(`\n# issuer-service/.env`);
  console.log(`RPC_URL=https://purechainnode.com:8547`);
  console.log(`CHAIN_ID=900520900520`);
  console.log(`BIOPASSPORT_CONTRACT_ADDRESS=${registryAddress}`);
  console.log(`\n# services/.env`);
  console.log(`RPC_URL=https://purechainnode.com:8547`);
  console.log(`CHAIN_ID=900520900520`);
  console.log(`CONTRACT_ADDRESS=${v2Address}`);
  console.log(`\n# verifier-cli (environment)`);
  console.log(`CONTRACT_ADDRESS=${registryAddress}`);

  console.log("\n✅ All contracts deployed successfully!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
