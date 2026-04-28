#!/usr/bin/env bash
# Generate a deterministic Hyperledger Besu Clique genesis for N signers.
# Usage:
#   ./scripts/generate-genesis.sh 3
set -euo pipefail

N="${1:-1}"
if [[ ! "$N" =~ ^(1|3|5|7)$ ]]; then
  echo "N must be one of: 1, 3, 5, 7" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

rm -rf node1 node2 node3 node4 node5 node6 node7 genesis.json validators.json static-nodes.json

node - "$N" <<'NODE'
const fs = require('fs');
const { SigningKey, computeAddress } = require('ethers');

const n = Number(process.argv[2]);
const chainId = 2026;
const blockPeriodSeconds = 1;

const deployer = 'aa3dfc054293dd3731892a1ba0366d6e6fb1ee51';
const keys = Array.from({ length: 7 }, (_, i) =>
  (BigInt(i + 1).toString(16).padStart(64, '0'))
);
const benchmarkKeys = Array.from({ length: 32 }, (_, i) =>
  (BigInt(1000 + i).toString(16).padStart(64, '0'))
);

const validators = keys.slice(0, n).map((privateKey, i) => {
  const signingKey = new SigningKey('0x' + privateKey);
  const publicKey = signingKey.publicKey.replace(/^0x04/, '');
  const address = computeAddress('0x' + privateKey).replace(/^0x/, '').toLowerCase();
  const node = `node${i + 1}`;
  const ip = `172.28.1.${11 + i}`;
  fs.mkdirSync(node, { recursive: true });
  fs.writeFileSync(`${node}/key`, privateKey + '\n');
  return {
    index: i + 1,
    node,
    ip,
    privateKey: '0x' + privateKey,
    address: '0x' + address,
    publicKey: '0x' + publicKey,
    enode: `enode://${publicKey}@${ip}:${30303 + i}`,
  };
});

for (let i = n + 1; i <= 7; i++) {
  fs.mkdirSync(`node${i}`, { recursive: true });
}

const vanity = '00'.repeat(32);
const signerBytes = validators.map((v) => v.address.replace(/^0x/, '')).join('');
const seal = '00'.repeat(65);
const extraData = '0x' + vanity + signerBytes + seal;

const genesis = {
  config: {
    chainId,
    homesteadBlock: 0,
    eip150Block: 0,
    eip155Block: 0,
    eip158Block: 0,
    byzantiumBlock: 0,
    constantinopleBlock: 0,
    petersburgBlock: 0,
    istanbulBlock: 0,
    berlinBlock: 0,
    londonBlock: 0,
    clique: { blockperiodseconds: blockPeriodSeconds, epochlength: 30000 },
    zeroBaseFee: true,
  },
  nonce: '0x0',
  timestamp: '0x0',
  extraData,
  gasLimit: '0x1fffffffffffff',
  difficulty: '0x1',
  mixHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  coinbase: '0x0000000000000000000000000000000000000000',
  alloc: {
    [deployer]: { balance: '0x3635c9adc5dea00000' },
  },
};

const benchmarkAccounts = benchmarkKeys.map((privateKey, i) => {
  const address = computeAddress('0x' + privateKey).replace(/^0x/, '').toLowerCase();
  genesis.alloc[address] = { balance: '0x3635c9adc5dea00000' };
  return { index: i, privateKey: '0x' + privateKey, address: '0x' + address };
});

fs.writeFileSync('genesis.json', JSON.stringify(genesis, null, 2));
fs.writeFileSync('validators.json', JSON.stringify({ chainId, blockPeriodSeconds, validators, benchmarkAccounts }, null, 2));
fs.writeFileSync('static-nodes.json', JSON.stringify(validators.map((v) => v.enode), null, 2));

console.log(`Generated genesis.json for ${n} Clique signer(s)`);
for (const v of validators) {
  console.log(`${v.node} ${v.address} ${v.enode}`);
}
NODE
