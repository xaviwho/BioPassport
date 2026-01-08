/**
 * BioPassport Demo Scenario
 * 
 * Demonstrates the full lifecycle of a cell line:
 * 1. Registration by Lab A
 * 2. Identity credential issuance
 * 3. Mycoplasma QC credential issuance by QC Lab
 * 4. Transfer to Lab B
 * 5. Verification at each step
 * 6. Quarantine scenario
 */

import { createIssuer } from '../issuer-service/src/issuer';
import { createVerifier } from '../verifier-cli/src/verifier';

async function runDemoScenario(): Promise<void> {
  console.log('═'.repeat(70));
  console.log('  BIOPASSPORT DEMO SCENARIO');
  console.log('  Full Cell Line Lifecycle Demonstration');
  console.log('═'.repeat(70));
  console.log();

  // Initialize services for different organizations
  const labAIssuer = createIssuer({ orgId: 'LabA_MSP' });
  const qcLabIssuer = createIssuer({ orgId: 'QCLab_MSP' });
  const labBIssuer = createIssuer({ orgId: 'LabB_MSP' });
  const verifier = createVerifier();

  await labAIssuer.init();
  await qcLabIssuer.init();
  await labBIssuer.init();

  try {
    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: Lab A registers a new cell line
    // ═══════════════════════════════════════════════════════════════════
    console.log('─'.repeat(70));
    console.log('STEP 1: Lab A registers HeLa cell line');
    console.log('─'.repeat(70));

    const registration = await labAIssuer.registerMaterial('CELL_LINE', {
      name: 'HeLa',
      description: 'Human cervical cancer cell line',
      species: 'Homo sapiens',
      tissueType: 'Cervix',
      cellType: 'Epithelial',
      diseaseModel: 'Cervical adenocarcinoma',
      biosafety: 'BSL-2',
      cultureConditions: {
        medium: 'DMEM',
        supplements: ['10% FBS', '1% Pen/Strep'],
        temperature: 37,
        co2Percentage: 5
      }
    });

    console.log(`  ✓ Material registered: ${registration.materialId}`);
    console.log(`  ✓ Metadata hash: ${registration.metadataHash.substring(0, 16)}...`);
    console.log(`  ✓ Transaction: ${registration.txId}`);
    console.log();

    const materialId = registration.materialId;

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: Lab A issues IDENTITY credential (STR profile)
    // ═══════════════════════════════════════════════════════════════════
    console.log('─'.repeat(70));
    console.log('STEP 2: Lab A issues IDENTITY credential (STR profile)');
    console.log('─'.repeat(70));

    const identityCredential = await labAIssuer.issueIdentityCredential(
      materialId,
      'STR_PROFILE',
      'a1b2c3d4e5f6...', // Hash of actual STR profile
      {
        referenceDatabase: 'Cellosaurus',
        matchScore: 100,
        matchThreshold: 80,
        validityDays: 365
      }
    );

    console.log(`  ✓ Identity credential issued: ${identityCredential.credentialId}`);
    console.log(`  ✓ Commitment hash: ${identityCredential.commitmentHash.substring(0, 16)}...`);
    console.log();

    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: QC Lab issues mycoplasma test credential
    // ═══════════════════════════════════════════════════════════════════
    console.log('─'.repeat(70));
    console.log('STEP 3: QC Lab issues mycoplasma QC credential');
    console.log('─'.repeat(70));

    const mycoCredential = await qcLabIssuer.issueMycoCredential(
      materialId,
      'NEGATIVE',
      'PCR',
      '2026-01-06',
      'Certified QC Laboratory',
      {
        labAccreditation: 'ISO-17025-12345',
        sampleId: 'QC-2026-0001',
        passageNumber: 5,
        validityDays: 90
      }
    );

    console.log(`  ✓ QC credential issued: ${mycoCredential.credentialId}`);
    console.log(`  ✓ Result: NEGATIVE`);
    console.log(`  ✓ Valid for 90 days`);
    console.log();

    // ═══════════════════════════════════════════════════════════════════
    // STEP 4: Verify material (should PASS)
    // ═══════════════════════════════════════════════════════════════════
    console.log('─'.repeat(70));
    console.log('STEP 4: Verify material (expecting PASS)');
    console.log('─'.repeat(70));

    const verification1 = await verifier.verify(materialId);
    printVerificationSummary(verification1);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 5: Lab A transfers to Lab B
    // ═══════════════════════════════════════════════════════════════════
    console.log('─'.repeat(70));
    console.log('STEP 5: Lab A transfers cell line to Lab B');
    console.log('─'.repeat(70));

    const transfer = await labAIssuer.transferMaterial(materialId, 'LabB_MSP');
    console.log(`  ✓ Transfer initiated: ${transfer.transferId}`);
    console.log(`  ✓ From: LabA_MSP → To: LabB_MSP`);
    console.log();

    // Issue transfer credential
    const transferCredential = await labAIssuer.issueTransferCredential(
      materialId,
      'LabA_MSP',
      'LabB_MSP',
      'DRY_ICE',
      {
        carrier: 'FedEx',
        trackingNumber: 'FX123456789',
        quantity: { vials: 5, cellCount: '1x10^6 cells/vial' },
        passageNumber: 6
      }
    );
    console.log(`  ✓ Transfer credential issued: ${transferCredential.credentialId}`);
    console.log();

    // ═══════════════════════════════════════════════════════════════════
    // STEP 6: Verify after transfer (should still PASS)
    // ═══════════════════════════════════════════════════════════════════
    console.log('─'.repeat(70));
    console.log('STEP 6: Verify after transfer (expecting PASS)');
    console.log('─'.repeat(70));

    const verification2 = await verifier.verify(materialId);
    printVerificationSummary(verification2);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 7: Contamination detected - Quarantine!
    // ═══════════════════════════════════════════════════════════════════
    console.log('─'.repeat(70));
    console.log('STEP 7: ⚠️  Contamination detected - QUARANTINE');
    console.log('─'.repeat(70));

    await labBIssuer.setMaterialStatus(
      materialId,
      'QUARANTINED',
      'Potential mycoplasma contamination detected during routine check'
    );
    console.log(`  ⚠️  Material quarantined`);
    console.log(`  ⚠️  Reason: Potential mycoplasma contamination`);
    console.log();

    // ═══════════════════════════════════════════════════════════════════
    // STEP 8: Verify quarantined material (should FAIL)
    // ═══════════════════════════════════════════════════════════════════
    console.log('─'.repeat(70));
    console.log('STEP 8: Verify quarantined material (expecting FAIL)');
    console.log('─'.repeat(70));

    const verification3 = await verifier.verify(materialId);
    printVerificationSummary(verification3);

    // ═══════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════
    console.log('═'.repeat(70));
    console.log('  DEMO COMPLETE');
    console.log('═'.repeat(70));
    console.log();
    console.log('  This demo showed:');
    console.log('  1. Material registration with metadata hashing');
    console.log('  2. Identity credential issuance (STR profile)');
    console.log('  3. QC credential issuance by authorized lab');
    console.log('  4. Policy-based verification (PASS)');
    console.log('  5. Chain-of-custody transfer');
    console.log('  6. Quarantine enforcement');
    console.log('  7. Verification failure after quarantine');
    console.log();

  } finally {
    await labAIssuer.close();
    await qcLabIssuer.close();
    await labBIssuer.close();
  }
}

function printVerificationSummary(result: any): void {
  if (result.pass) {
    console.log('  ✓ VERIFICATION: PASS');
  } else {
    console.log('  ✗ VERIFICATION: FAIL');
  }
  console.log(`  Score: ${result.overallScore}%`);
  
  if (result.checks) {
    const failures = result.checks.filter((c: any) => !c.pass);
    if (failures.length > 0) {
      console.log('  Failures:');
      failures.forEach((f: any) => {
        console.log(`    - ${f.message}`);
      });
    }
  }
  console.log();
}

// Run demo
runDemoScenario().catch(console.error);
