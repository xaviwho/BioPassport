import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-contract-sizer";
import * as fs from "fs";
import * as path from "path";

for (const envPath of [
  path.resolve(__dirname, ".env"),
  path.resolve(__dirname, "..", "issuer-service", ".env"),
]) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

const purechainPrivateKey = process.env.PRIVATE_KEY || process.env.PURECHAIN_PRIVATE_KEY;
const purechainRpcUrl = process.env.PURECHAIN_RPC_URL || process.env.RPC_URL || "https://purechainnode.com:8547";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 50
      }
    }
  },
  networks: {
    hardhat: {
      chainId: 31337,
      blockGasLimit: 0x1fffffffffffff,
      gas: 60000000
    },
    purechain: {
      url: purechainRpcUrl,
      chainId: 900520900520,
      gasPrice: 0,
      accounts: purechainPrivateKey ? [`0x${purechainPrivateKey.replace(/^0x/, "")}`] : []
    },
    besu: {
      url: "http://localhost:8545",
      chainId: 2026,
      gasPrice: 0,
      accounts: purechainPrivateKey ? [`0x${purechainPrivateKey.replace(/^0x/, "")}`] : []
    }
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  contractSizer: {
    runOnCompile: false,
    strict: true
  }
};

export default config;
