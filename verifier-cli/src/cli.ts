#!/usr/bin/env node
/**
 * BioPassport Verifier CLI
 * 
 * Command-line tool for verifying biomaterial credentials and policies.
 */

import { Command, OptionValues } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { table } from 'table';
import { createVerifier, VerificationResult } from './verifier';

const program = new Command();

program
  .name('biopassport')
  .description('BioPassport Material Verification CLI')
  .version('1.0.0');

// Verify command
program
  .command('verify')
  .description('Verify a material against policy rules')
  .requiredOption('-m, --material <id>', 'Material ID to verify')
  .option('-t, --time <datetime>', 'Verify at specific time (ISO 8601)')
  .option('-a, --artifacts', 'Verify off-chain artifact integrity', false)
  .option('-s, --signatures', 'Verify credential signatures', false)
  .option('--json', 'Output as JSON', false)
  .option('--trusted-issuers <issuers>', 'Comma-separated list of trusted issuer IDs')
  .action(async (options: OptionValues) => {
    const spinner = ora('Verifying material...').start();
    
    try {
      const verifier = createVerifier({
        trustedIssuers: options.trustedIssuers?.split(',')
      });

      const result = await verifier.verify(options.material, {
        atTime: options.time,
        verifyArtifacts: options.artifacts,
        verifySignatures: options.signatures
      });

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.pass ? 0 : 1);
      }

      printVerificationReport(result);
      process.exit(result.pass ? 0 : 1);
    } catch (error) {
      spinner.fail(chalk.red('Verification failed'));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

// Quick verify command
program
  .command('quick-verify')
  .description('Quick verification (on-chain only)')
  .requiredOption('-m, --material <id>', 'Material ID to verify')
  .option('--json', 'Output as JSON', false)
  .action(async (options: OptionValues) => {
    const spinner = ora('Verifying material...').start();
    
    try {
      const verifier = createVerifier();
      const result = await verifier.quickVerify(options.material);

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.pass ? 0 : 1);
      }

      if (result.pass) {
        console.log(chalk.green.bold('\n✓ PASS\n'));
      } else {
        console.log(chalk.red.bold('\n✗ FAIL\n'));
        console.log(chalk.bold('Reasons:'));
        result.reasons.forEach(reason => {
          console.log(chalk.red(`  • ${reason}`));
        });
      }
      
      process.exit(result.pass ? 0 : 1);
    } catch (error) {
      spinner.fail(chalk.red('Verification failed'));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

// History command
program
  .command('history')
  .description('Get material history')
  .requiredOption('-m, --material <id>', 'Material ID')
  .option('--json', 'Output as JSON', false)
  .action(async (options: OptionValues) => {
    const spinner = ora('Fetching history...').start();
    
    try {
      // In production, this would query the chain
      spinner.succeed('History retrieved');
      console.log(chalk.yellow('\nHistory query not yet implemented in demo mode'));
      console.log(`Material: ${options.material}`);
    } catch (error) {
      spinner.fail(chalk.red('Failed to fetch history'));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

/**
 * Print formatted verification report
 */
function printVerificationReport(result: VerificationResult): void {
  console.log('\n' + '═'.repeat(60));
  console.log(chalk.bold('  BIOPASSPORT VERIFICATION REPORT'));
  console.log('═'.repeat(60) + '\n');

  // Overall result
  if (result.pass) {
    console.log(chalk.green.bold('  ✓ VERIFICATION PASSED'));
  } else {
    console.log(chalk.red.bold('  ✗ VERIFICATION FAILED'));
  }
  console.log(`  Score: ${result.overallScore}%\n`);

  // Material info
  console.log(chalk.bold('─ Material Information ─'));
  console.log(`  Material ID: ${chalk.cyan(result.materialId)}`);
  if (result.material) {
    console.log(`  Type: ${result.material.materialType}`);
    console.log(`  Owner: ${result.material.ownerOrg}`);
    console.log(`  Status: ${formatStatus(result.material.status)}`);
    console.log(`  Created: ${result.material.createdAt}`);
  }
  console.log();

  // Verification checks
  console.log(chalk.bold('─ Verification Checks ─'));
  result.checks.forEach(check => {
    const icon = check.pass ? chalk.green('✓') : chalk.red('✗');
    const severity = check.severity === 'ERROR' ? chalk.red : 
                     check.severity === 'WARNING' ? chalk.yellow : chalk.dim;
    console.log(`  ${icon} ${check.name}: ${severity(check.message)}`);
  });
  console.log();

  // Credential summary
  if (result.credentialSummary.length > 0) {
    console.log(chalk.bold('─ Credentials ─'));
    const credData = result.credentialSummary.map(cred => [
      cred.credentialType,
      formatCredentialStatus(cred.status),
      cred.issuerId || '-',
      cred.validUntil ? new Date(cred.validUntil).toLocaleDateString() : '-'
    ]);
    
    const credTable = table([
      ['Type', 'Status', 'Issuer', 'Valid Until'],
      ...credData
    ], {
      border: {
        topBody: '─',
        topJoin: '┬',
        topLeft: '┌',
        topRight: '┐',
        bottomBody: '─',
        bottomJoin: '┴',
        bottomLeft: '└',
        bottomRight: '┘',
        bodyLeft: '│',
        bodyRight: '│',
        bodyJoin: '│',
        joinBody: '─',
        joinLeft: '├',
        joinRight: '┤',
        joinJoin: '┼'
      }
    });
    console.log(credTable);
  }

  // Transfer chain
  console.log(chalk.bold('─ Transfer Chain ─'));
  if (result.transferChain.valid) {
    console.log(chalk.green(`  ✓ Valid (${result.transferChain.transfers.length} transfers)`));
  } else {
    console.log(chalk.red('  ✗ Invalid'));
    if (result.transferChain.gaps.length > 0) {
      console.log(`  Gaps: ${result.transferChain.gaps.join(', ')}`);
    }
    if (result.transferChain.pendingTransfers.length > 0) {
      console.log(`  Pending: ${result.transferChain.pendingTransfers.join(', ')}`);
    }
  }
  console.log();

  // Artifact integrity
  if (result.artifactIntegrity.length > 0) {
    console.log(chalk.bold('─ Artifact Integrity ─'));
    result.artifactIntegrity.forEach(artifact => {
      const icon = artifact.valid ? chalk.green('✓') : chalk.red('✗');
      const name = artifact.filename || artifact.artifactCid;
      console.log(`  ${icon} ${name}`);
      if (!artifact.valid && artifact.error) {
        console.log(chalk.red(`      Error: ${artifact.error}`));
      }
    });
    console.log();
  }

  // Footer
  console.log('─'.repeat(60));
  console.log(`  Verified at: ${result.verifiedAt}`);
  console.log('═'.repeat(60) + '\n');
}

function formatStatus(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return chalk.green(status);
    case 'QUARANTINED':
      return chalk.yellow(status);
    case 'REVOKED':
      return chalk.red(status);
    case 'EXPIRED':
      return chalk.gray(status);
    default:
      return status;
  }
}

function formatCredentialStatus(status: string): string {
  switch (status) {
    case 'VALID':
      return chalk.green(status);
    case 'EXPIRED':
      return chalk.yellow(status);
    case 'REVOKED':
      return chalk.red(status);
    case 'MISSING':
      return chalk.red(status);
    default:
      return status;
  }
}

program.parse();
