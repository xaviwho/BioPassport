#!/usr/bin/env node
/**
 * BioPassport Issuer CLI
 * 
 * Command-line interface for material registration and credential issuance.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { createIssuer } from './issuer';
import { MaterialMetadata } from './types';

const program = new Command();

program
  .name('biopassport-issuer')
  .description('BioPassport Credential Issuer CLI')
  .version('1.0.0');

// Register material command
program
  .command('register')
  .description('Register a new biomaterial')
  .requiredOption('-t, --type <type>', 'Material type (CELL_LINE, PLASMID, TISSUE, ORGANISM)')
  .requiredOption('-m, --metadata <path>', 'Path to metadata JSON file')
  .option('-o, --org <orgId>', 'Organization ID', process.env.ISSUER_ORG_ID)
  .action(async (options) => {
    const spinner = ora('Registering material...').start();
    
    try {
      // Load metadata
      const metadataJson = fs.readFileSync(options.metadata, 'utf-8');
      const metadata: MaterialMetadata = JSON.parse(metadataJson);

      // Create issuer
      const issuer = createIssuer({ orgId: options.org });
      await issuer.init();

      // Register material
      const result = await issuer.registerMaterial(options.type, metadata);

      await issuer.close();

      spinner.succeed(chalk.green('Material registered successfully!'));
      console.log('\n' + chalk.bold('Registration Details:'));
      console.log(`  ${chalk.cyan('Material ID:')} ${result.materialId}`);
      console.log(`  ${chalk.cyan('Type:')} ${result.materialType}`);
      console.log(`  ${chalk.cyan('Metadata Hash:')} ${result.metadataHash}`);
      console.log(`  ${chalk.cyan('Transaction ID:')} ${result.txId}`);
      console.log(`  ${chalk.cyan('Created At:')} ${result.createdAt}`);
    } catch (error) {
      spinner.fail(chalk.red('Registration failed'));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

// Issue credential command
program
  .command('issue')
  .description('Issue a credential for a material')
  .requiredOption('-m, --material <id>', 'Material ID')
  .requiredOption('-t, --type <type>', 'Credential type (IDENTITY, QC_MYCO, TRANSFER, USAGE_RIGHTS)')
  .requiredOption('-p, --payload <path>', 'Path to credential payload JSON file')
  .option('-a, --artifacts <paths...>', 'Paths to artifact files')
  .option('-v, --validity <days>', 'Validity period in days', '90')
  .option('-o, --org <orgId>', 'Organization ID', process.env.ISSUER_ORG_ID)
  .action(async (options) => {
    const spinner = ora('Issuing credential...').start();
    
    try {
      // Load payload
      const payloadJson = fs.readFileSync(options.payload, 'utf-8');
      const payload = JSON.parse(payloadJson);

      // Create issuer
      const issuer = createIssuer({ orgId: options.org });
      await issuer.init();

      // Issue credential
      const result = await issuer.issueCredential(
        options.material,
        options.type,
        payload,
        options.artifacts || [],
        parseInt(options.validity)
      );

      await issuer.close();

      spinner.succeed(chalk.green('Credential issued successfully!'));
      console.log('\n' + chalk.bold('Credential Details:'));
      console.log(`  ${chalk.cyan('Credential ID:')} ${result.credentialId}`);
      console.log(`  ${chalk.cyan('Material ID:')} ${result.materialId}`);
      console.log(`  ${chalk.cyan('Type:')} ${result.credentialType}`);
      console.log(`  ${chalk.cyan('Commitment Hash:')} ${result.commitmentHash}`);
      console.log(`  ${chalk.cyan('Transaction ID:')} ${result.txId}`);
      console.log(`  ${chalk.cyan('Issued At:')} ${result.issuedAt}`);
      
      if (result.artifactRefs.length > 0) {
        console.log(`\n  ${chalk.bold('Artifacts:')}`);
        result.artifactRefs.forEach((a, i) => {
          console.log(`    ${i + 1}. ${a.filename}`);
          console.log(`       ${chalk.dim('CID:')} ${a.cid}`);
          console.log(`       ${chalk.dim('Hash:')} ${a.hash}`);
        });
      }
    } catch (error) {
      spinner.fail(chalk.red('Credential issuance failed'));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

// Issue mycoplasma QC credential (shortcut)
program
  .command('issue-myco')
  .description('Issue a mycoplasma QC credential')
  .requiredOption('-m, --material <id>', 'Material ID')
  .requiredOption('-r, --result <result>', 'Test result (NEGATIVE, POSITIVE, INCONCLUSIVE)')
  .requiredOption('--method <method>', 'Test method (PCR, CULTURE, ELISA, etc.)')
  .requiredOption('--date <date>', 'Test date (YYYY-MM-DD)')
  .requiredOption('--lab <laboratory>', 'Laboratory name')
  .option('--accreditation <number>', 'Lab accreditation number')
  .option('--sample <id>', 'Sample ID')
  .option('--passage <number>', 'Passage number')
  .option('--report <path>', 'Path to test report PDF')
  .option('-v, --validity <days>', 'Validity period in days', '90')
  .option('-o, --org <orgId>', 'Organization ID', process.env.ISSUER_ORG_ID)
  .action(async (options) => {
    const spinner = ora('Issuing mycoplasma QC credential...').start();
    
    try {
      const issuer = createIssuer({ orgId: options.org });
      await issuer.init();

      const result = await issuer.issueMycoCredential(
        options.material,
        options.result,
        options.method,
        options.date,
        options.lab,
        {
          labAccreditation: options.accreditation,
          sampleId: options.sample,
          passageNumber: options.passage ? parseInt(options.passage) : undefined,
          reportPath: options.report,
          validityDays: parseInt(options.validity)
        }
      );

      await issuer.close();

      spinner.succeed(chalk.green('Mycoplasma QC credential issued!'));
      console.log('\n' + chalk.bold('Credential Details:'));
      console.log(`  ${chalk.cyan('Credential ID:')} ${result.credentialId}`);
      console.log(`  ${chalk.cyan('Material ID:')} ${result.materialId}`);
      console.log(`  ${chalk.cyan('Commitment Hash:')} ${result.commitmentHash}`);
      console.log(`  ${chalk.cyan('Transaction ID:')} ${result.txId}`);
    } catch (error) {
      spinner.fail(chalk.red('Credential issuance failed'));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

// Transfer material command
program
  .command('transfer')
  .description('Transfer material to another organization')
  .requiredOption('-m, --material <id>', 'Material ID')
  .requiredOption('--to <orgId>', 'Receiving organization ID')
  .option('--shipment-form <path>', 'Path to shipment form')
  .option('-o, --org <orgId>', 'Organization ID', process.env.ISSUER_ORG_ID)
  .action(async (options) => {
    const spinner = ora('Transferring material...').start();
    
    try {
      const issuer = createIssuer({ orgId: options.org });
      await issuer.init();

      const result = await issuer.transferMaterial(
        options.material,
        options.to,
        options.shipmentForm
      );

      await issuer.close();

      spinner.succeed(chalk.green('Material transfer initiated!'));
      console.log('\n' + chalk.bold('Transfer Details:'));
      console.log(`  ${chalk.cyan('Transfer ID:')} ${result.transferId}`);
      console.log(`  ${chalk.cyan('Transaction ID:')} ${result.txId}`);
    } catch (error) {
      spinner.fail(chalk.red('Transfer failed'));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

// Set status command
program
  .command('set-status')
  .description('Set material status (QUARANTINE/REVOKE)')
  .requiredOption('-m, --material <id>', 'Material ID')
  .requiredOption('-s, --status <status>', 'New status (ACTIVE, QUARANTINED, REVOKED)')
  .requiredOption('-r, --reason <reason>', 'Reason for status change')
  .option('-o, --org <orgId>', 'Organization ID', process.env.ISSUER_ORG_ID)
  .action(async (options) => {
    const spinner = ora('Setting material status...').start();
    
    try {
      const issuer = createIssuer({ orgId: options.org });
      await issuer.init();

      const result = await issuer.setMaterialStatus(
        options.material,
        options.status,
        options.reason
      );

      await issuer.close();

      spinner.succeed(chalk.green(`Material status set to ${options.status}!`));
      console.log(`  ${chalk.cyan('Transaction ID:')} ${result.txId}`);
    } catch (error) {
      spinner.fail(chalk.red('Status change failed'));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

// Revoke credential command
program
  .command('revoke')
  .description('Revoke a credential')
  .requiredOption('-c, --credential <id>', 'Credential ID')
  .requiredOption('-r, --reason <reason>', 'Reason for revocation')
  .option('-o, --org <orgId>', 'Organization ID', process.env.ISSUER_ORG_ID)
  .action(async (options) => {
    const spinner = ora('Revoking credential...').start();
    
    try {
      const issuer = createIssuer({ orgId: options.org });
      await issuer.init();

      const result = await issuer.revokeCredential(
        options.credential,
        options.reason
      );

      await issuer.close();

      spinner.succeed(chalk.green('Credential revoked!'));
      console.log(`  ${chalk.cyan('Transaction ID:')} ${result.txId}`);
    } catch (error) {
      spinner.fail(chalk.red('Revocation failed'));
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

program.parse();
