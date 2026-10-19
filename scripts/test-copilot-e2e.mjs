/**
 * Comprehensive Live End-to-End Verification Suite for Antigravity Browser Co-Pilot
 *
 * Runs directly against the live Tandem Browser instance at http://127.0.0.1:8765.
 * Tests:
 * 1. Health & Status
 * 2. Navigation & Tab Management
 * 3. Page Summarization & Understanding
 * 4. Autonomous Account Signup Intent (Google/Gmail)
 * 5. Stagehand Self-Healing Form Input Typing (React/Polymer prototype setter)
 * 6. Compound Autonomous Goal Execution ("open X and Y")
 * 7. Structured Data Extraction (/extract)
 * 8. Set-of-Marks (SoM) Element Numbering & Targeting (/mark, /click N)
 * 9. Web Search & N-th Result Clicker ("click the first result")
 * 10. Visual Screenshot Verification
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BASE_URL = 'http://127.0.0.1:8765';
const TOKEN = fs.readFileSync(path.join(os.homedir(), '.tandem', 'api-token'), 'utf-8').trim();

const HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json'
};

let passedCount = 0;
let failedCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passedCount++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failedCount++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function api(endpoint, method = 'GET', body = null) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${endpoint} returned ${res.status}: ${text}`);
  }
  return res.json();
}

async function executeJs(code) {
  const res = await api('/execute-js', 'POST', { code });
  return res.result;
}

async function sendUserMessage(text) {
  // Post user message to chat bus
  const postRes = await api('/chat', 'POST', {
    from: 'user',
    text,
    targetAgent: 'antigravity'
  });
  const msgId = postRes.message.id;

  // Wait for Antigravity's response via long poll /chat/wait
  const startTime = Date.now();
  let lastProgressText = null;
  while (Date.now() - startTime < 35000) {
    const waitRes = await api(`/chat/wait?since_id=${msgId}&timeout_ms=5000`);
    if (waitRes.messages && waitRes.messages.length > 0) {
      const agentReplies = waitRes.messages.filter(m => m.from === 'antigravity' && m.id > msgId);
      // If there's a non-step message, return it as final
      const finalReply = agentReplies.find(m => !m.text.startsWith('⏳ **Step'));
      if (finalReply) {
        return finalReply.text;
      }
      if (agentReplies.length > 0) {
        lastProgressText = agentReplies[agentReplies.length - 1].text;
      }
    }
    // brief sleep if not yet received
    await new Promise(r => setTimeout(r, 600));
  }
  if (lastProgressText) return lastProgressText;
  throw new Error(`Timeout waiting for Antigravity response to: "${text}"`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runE2ETests() {
  console.log('\n🚀 Starting Antigravity Browser Co-Pilot Full E2E Test Suite...\n');

  // --------------------------------------------------------------------------
  console.log('--- 1. Health & Status Verification ---');
  // --------------------------------------------------------------------------
  const status = await api('/status');
  assert(status.ready === true, 'Tandem Browser is ready');
  assert(typeof status.version === 'string', `Tandem Version: ${status.version}`);
  assert(typeof status.activeTab === 'string', `Active tab is: ${status.activeTab}`);

  // --------------------------------------------------------------------------
  console.log('\n--- 2. Direct Navigation & Page Verification ---');
  // --------------------------------------------------------------------------
  const navReply = await sendUserMessage('go to https://example.com');
  console.log(`  Agent reply: "${navReply.slice(0, 80)}..."`);
  assert(navReply.toLowerCase().includes('example.com') || navReply.toLowerCase().includes('opened'), 'Agent confirmed opening example.com');
  
  await sleep(1500);
  const pageStatus = await api('/status');
  assert(pageStatus.url.includes('example.com'), `Browser navigated to: ${pageStatus.url}`);

  const pageTitle = await executeJs('document.title');
  assert(pageTitle === 'Example Domain', `Page title verified in DOM: "${pageTitle}"`);

  // --------------------------------------------------------------------------
  console.log('\n--- 3. Page Reading & Summarization (/summarize) ---');
  // --------------------------------------------------------------------------
  const summaryReply = await sendUserMessage('/summarize');
  console.log(`  Agent summary: "${summaryReply.slice(0, 100)}..."`);
  assert(
    summaryReply.toLowerCase().includes('example') || summaryReply.toLowerCase().includes('domain'),
    'Summary contains page key terms ("example" or "domain")'
  );

  // --------------------------------------------------------------------------
  console.log('\n--- 4. Autonomous Account Signup Intent ("create one new gmail for me") ---');
  // --------------------------------------------------------------------------
  console.log('  Sending intent: "create one new gmail for me"');
  const signupReply = await sendUserMessage('create one new gmail for me');
  console.log(`  Agent reply: "${signupReply.slice(0, 120)}..."`);
  
  assert(
    signupReply.toLowerCase().includes('google') || signupReply.toLowerCase().includes('signup') || signupReply.toLowerCase().includes('first name'),
    'Agent recognized Gmail/Google signup flow'
  );

  await sleep(2500);
  const signupStatus = await api('/status');
  assert(
    signupStatus.url.includes('accounts.google.com'),
    `Browser actively navigated to canonical signup URL: ${signupStatus.url}`
  );

  // Check form inspection discovered the fields in the live DOM
  const formFieldNames = await executeJs(`
    (() => {
      const inputs = [...document.querySelectorAll('input')].filter(i => i.type !== 'hidden');
      return inputs.map(i => i.name || i.getAttribute('aria-label') || i.placeholder || i.id);
    })()
  `);
  console.log('  Live DOM visible fields:', formFieldNames);
  assert(formFieldNames.length >= 1, `Found ${formFieldNames.length} form input fields on the live signup page`);

  // --------------------------------------------------------------------------
  console.log('\n--- 5. Stagehand Self-Healing Form Input Typing ---');
  // --------------------------------------------------------------------------
  console.log('  Testing typing: "type Jane into First name"');
  const typeFirstReply = await sendUserMessage('type Jane into First name');
  console.log(`  Agent reply: "${typeFirstReply}"`);
  assert(/typed/i.test(typeFirstReply) && /jane/i.test(typeFirstReply), 'Agent confirmed typing Jane');

  // Verify directly in the live browser DOM that the input actually received the value
  const firstInputValue = await executeJs(`
    (() => {
      const fn = document.querySelector('input[name="firstName"]') ||
                 document.querySelector('input[aria-label*="First" i]') ||
                 document.querySelector('input');
      return fn ? fn.value : null;
    })()
  `);
  console.log(`  DOM First Name input value: "${firstInputValue}"`);
  assert(firstInputValue === 'Jane', 'First Name input in DOM has value "Jane" via React prototype setter');

  // Now type the last name
  console.log('  Testing typing: "type Doe into Last name"');
  const typeLastReply = await sendUserMessage('type Doe into Last name');
  console.log(`  Agent reply: "${typeLastReply}"`);
  assert(/typed/i.test(typeLastReply) && /doe/i.test(typeLastReply), 'Agent confirmed typing Doe');

  const lastInputValue = await executeJs(`
    (() => {
      const ln = document.querySelector('input[name="lastName"]') ||
                 document.querySelector('input[aria-label*="Last" i]') ||
                 document.querySelectorAll('input')[1];
      return ln ? ln.value : null;
    })()
  `);
  console.log(`  DOM Last Name input value: "${lastInputValue}"`);
  assert(lastInputValue === 'Doe', 'Last Name input in DOM has value "Doe"');

  // --------------------------------------------------------------------------
  console.log('\n--- 6. Autonomous Roadblock Sweeper (/dismiss) ---');
  // --------------------------------------------------------------------------
  const dismissReply = await sendUserMessage('/dismiss');
  console.log(`  Agent reply: "${dismissReply}"`);
  assert(dismissReply.includes('Dismissed') || dismissReply.includes('Clean'), 'Overlay dismissal sweeper executed cleanly');

  // --------------------------------------------------------------------------
  console.log('\n--- 7. Compound Autonomous Execution ("open X and Y") ---');
  // --------------------------------------------------------------------------
  console.log('  Sending compound command: "open https://news.ycombinator.com and summarize"');
  const compoundReply = await sendUserMessage('open https://news.ycombinator.com and summarize');
  console.log(`  Agent compound reply: "${compoundReply.slice(0, 120)}..."`);
  assert(
    compoundReply.toLowerCase().includes('hacker news') || compoundReply.toLowerCase().includes('ycombinator') || compoundReply.toLowerCase().includes('summary'),
    'Compound plan executed both navigation and summarization'
  );

  await sleep(3500);
  const hnStatus = await api('/status');
  assert(hnStatus.url.includes('news.ycombinator.com'), `Browser navigated to: ${hnStatus.url}`);

  // --------------------------------------------------------------------------
  console.log('\n--- 8. Structured Data Extraction (/extract) ---');
  // --------------------------------------------------------------------------
  console.log('  Testing structured extraction on Hacker News...');
  const extractReply = await sendUserMessage('/extract');
  console.log(`  Extraction sample: "${extractReply.slice(0, 150)}..."`);
  assert(
    extractReply.includes('Extracted') || extractReply.includes('table') || extractReply.includes('records') || extractReply.includes('Download'),
    'Structured table/item extraction returned formatted results'
  );

  // --------------------------------------------------------------------------
  console.log('\n--- 9. Set-of-Marks (SoM) Tagging & Numbered Click (/mark, /click 1) ---');
  // --------------------------------------------------------------------------
  console.log('  Testing visual element tagging: /mark');
  const markReply = await sendUserMessage('/mark');
  console.log(`  Agent reply: "${markReply}"`);
  assert(markReply.includes('Numbered') || markReply.includes('marked'), 'Elements were tagged with SoM badges');

  // Verify visual markers in DOM
  const markerCount = await executeJs('document.querySelectorAll(".antigravity-marker").length');
  console.log(`  Visual badges rendered on page: ${markerCount}`);
  assert(markerCount > 0, `DOM contains ${markerCount} visual marker badges`);

  // Now click mark 1
  console.log('  Testing numbered click: /click 1');
  const clickReply = await sendUserMessage('/click 1');
  console.log(`  Agent reply: "${clickReply}"`);
  assert(clickReply.toLowerCase().includes('clicked') || clickReply.toLowerCase().includes('glided'), 'Element #1 clicked via ghost cursor');

  // Markers should be cleaned up after click
  const markersAfter = await executeJs('document.querySelectorAll(".antigravity-marker").length');
  assert(markersAfter === 0, 'Markers cleanly removed from DOM after click');

  // --------------------------------------------------------------------------
  console.log('\n--- 10. Web Search & N-th Search Result Clicker ---');
  // --------------------------------------------------------------------------
  console.log('  Testing search: "search for python language"');
  const searchReply = await sendUserMessage('search for python language');
  console.log(`  Agent reply: "${searchReply}"`);
  assert(searchReply.toLowerCase().includes('searching') || searchReply.toLowerCase().includes('python'), 'Agent initiated search');

  await sleep(3000);
  const searchStatus = await api('/status');
  assert(searchStatus.url.includes('google.com/search'), `Browser on Google search: ${searchStatus.url}`);

  // Test clicking the first result
  console.log('  Testing clicking 1st result: "click the first result"');
  const firstResultReply = await sendUserMessage('click the first result');
  console.log(`  Agent reply: "${firstResultReply}"`);
  assert(
    firstResultReply.toLowerCase().includes('clicked on result #1') || firstResultReply.toLowerCase().includes('python'),
    'Clicked first search result heading'
  );

  // --------------------------------------------------------------------------
  console.log('\n--- 11. Visual Screenshot Capture & Verification ---');
  // --------------------------------------------------------------------------
  const shotRes = await fetch(`${BASE_URL}/screenshot`, { headers: HEADERS });
  const contentType = shotRes.headers.get('content-type') || '';
  assert(shotRes.ok && contentType.includes('image/png'), 'Screenshot endpoint returned HTTP 200 with image/png');
  const arrayBuf = await shotRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  console.log(`  Screenshot PNG size: ${Math.round(buffer.length / 1024)} KB`);
  assert(buffer.length > 5000, `Screenshot size (${buffer.length} bytes) indicates a rendered visual page`);
  assert(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47, 'Valid PNG header signature detected');

  // --------------------------------------------------------------------------
  console.log('\n--- 12. Smart Persona Vault Management ---');
  // --------------------------------------------------------------------------
  console.log('  Testing /persona (view persona vault)');
  const personaViewReply = await sendUserMessage('/persona');
  console.log(`  Agent reply: "${personaViewReply.slice(0, 150)}..."`);
  assert(personaViewReply.includes('Smart Persona Vault'), 'Persona vault dashboard rendered');
  assert(personaViewReply.includes('Active Persona'), 'Active persona displayed in dashboard');

  console.log('  Testing /persona create staging');
  const personaCreateReply = await sendUserMessage('/persona create staging');
  assert(personaCreateReply.includes('Created new persona') && personaCreateReply.includes('staging'), 'Created new persona "staging"');

  console.log('  Testing /persona set email staging@endeavor.test');
  const personaSetReply = await sendUserMessage('/persona set email staging@endeavor.test');
  assert(personaSetReply.includes('Updated') && personaSetReply.includes('staging@endeavor.test'), 'Updated staging persona email');

  console.log('  Testing /persona use default');
  const personaUseReply = await sendUserMessage('/persona use default');
  assert(personaUseReply.includes('Switched active persona to') && personaUseReply.includes('default'), 'Switched back to default persona');

  // --------------------------------------------------------------------------
  console.log('\n--- 13. 1-Click Autonomous Form Autofill & Visual Breadcrumbs ---');
  // --------------------------------------------------------------------------
  console.log('  Injecting dynamic registration form into active tab DOM');
  await executeJs(`
    document.body.innerHTML = \`
      <div style="padding: 40px; font-family: sans-serif;">
        <h2>User Registration Form</h2>
        <form id="e2e-reg-form">
          <input type="text" id="fn" name="firstName" placeholder="First Name"><br><br>
          <input type="text" id="ln" name="lastName" placeholder="Last Name"><br><br>
          <input type="email" id="em" name="email" placeholder="Email Address"><br><br>
          <input type="tel" id="ph" name="phone" placeholder="Phone Number"><br><br>
          <input type="text" id="co" name="company" placeholder="Company"><br><br>
          <input type="text" id="zp" name="zip" placeholder="Zip code"><br><br>
        </form>
      </div>
    \`;
  `);

  console.log('  Sending /autofill command');
  const autofillReply = await sendUserMessage('/autofill');
  console.log(`  Agent reply: "${autofillReply.slice(0, 200)}..."`);
  assert(autofillReply.includes('1-Click Form Autofill Complete'), 'Autofill execution completed');
  assert(autofillReply.includes('breadcrumb-trail') || autofillReply.includes('Action Timeline'), 'Visual action breadcrumbs trail generated');

  // Verify DOM values actually populated
  const domFirstName = await executeJs('document.getElementById("fn").value');
  const domEmail = await executeJs('document.getElementById("em").value');
  const domCompany = await executeJs('document.getElementById("co").value');
  console.log(`  DOM Form Verification: firstName="${domFirstName}", email="${domEmail}", company="${domCompany}"`);
  assert(domFirstName === 'Alex', `First name correctly populated into DOM: ${domFirstName}`);
  assert(domEmail === 'alex.mercer.dev@gmail.com', `Email correctly populated into DOM: ${domEmail}`);
  assert(domCompany === 'Endeavor Labs', `Company correctly populated into DOM: ${domCompany}`);

  // --------------------------------------------------------------------------
  console.log('\n--- 14. Multi-Store Parallel Price Comparison ---');
  // --------------------------------------------------------------------------
  console.log('  Testing /compare Sony Headphones on google and amazon');
  const compareReply = await sendUserMessage('/compare Sony Headphones on google and amazon');
  console.log(`  Agent reply: "${compareReply.slice(0, 250)}..."`);
  assert(compareReply.includes('Comparison Matrix') || compareReply.includes('Store'), 'Comparison matrix table synthesized');
  assert(compareReply.includes('breadcrumb-trail') || compareReply.includes('Action Timeline'), 'Visual action breadcrumbs generated for multi-tab flow');

  // --------------------------------------------------------------------------
  console.log('\n======================================================');
  console.log(`🏁 E2E Test Complete: ${passedCount} passed, ${failedCount} failed`);
  console.log('======================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runE2ETests().catch(err => {
  console.error('\n❌ Unhandled E2E Test Failure:', err);
  process.exit(1);
});
