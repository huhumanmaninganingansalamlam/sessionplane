#!/usr/bin/env node
import { validateTestSuiteManifest } from './test-suite-manifest.mjs';

const result = validateTestSuiteManifest();
console.log('Test suite manifest passed: '+result.suites+' suites, '+
  result.gates+' exact candidate gates, '+result.tests+' distinct tests, '+
  result.acceptance+' acceptance owners.');
