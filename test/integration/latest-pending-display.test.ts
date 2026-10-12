import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import { observeChatGptDom } from '../../src/providers/chatgpt/dom-observer.ts';

test('explicit pending-anchor latest display preserves guards and recovers only exact turn evidence without submitting', async t => {
  const root=mkdtempSync(path.join(tmpdir(),'sessionplane-pending-latest-'));
  const config=resolveConfig({cwd:root,env:{},stateDir:'.state'});
  const fake=new FakeProviderAdapter();
  const core=await startCore({config,browserHeadless:true,providerAdapters:[fake],logger:{debug(){},info(){},warn(){},error(){}}});
  try {
    const team=core.teamDirectory.createTeam({clientId:'fixture-owner'});
    const session=core.teamDirectory.createSession({teamId:team.teamId,roleKey:'main',provider:'chatgpt'});
    const {page,binding}=await core.browserOwner!.createPage();
    let navigations=0;
    await page.route('https://chatgpt.com/**',r=>{navigations++;return r.fulfill({contentType:'text/html',body:'<main><section id="history"><div data-message-author-role="user" data-message-id="older-user">Older turn</div></section><textarea id="prompt-textarea"></textarea><button aria-label="Scroll to bottom">Latest</button></main>'});});
    await page.goto(`https://chatgpt.com/c/conversation-${session.sessionId}`);
    const open=fake.openSubmission.bind(fake);
    t.mock.method(fake,'openSubmission',async request=>({...await open(request),pageKey:binding.pageKey,
      bindAcknowledgement(){core.pageRegistry.reservePage(binding.pageKey,{sessionId:session.sessionId,generation:1,conversationId:`conversation-${session.sessionId}`});}}));
    await core.submissionService.send({clientId:'fixture-owner',requestId:'original',sessionId:session.sessionId,prompt:'Fixture question',sessionDeadlineSec:600});
    const row=core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(session.sessionId)!;
    const generation=core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(session.sessionId)!;
    await page.evaluate(()=>{document.querySelector('button')!.onclick=()=>{
      document.querySelector('button')!.dataset.clicks=String(Number(document.querySelector('button')!.dataset.clicks??0)+1);
      document.querySelector('#history')!.innerHTML='<div data-message-author-role="user" data-message-id="user-message-1">Fixture question</div><div data-message-author-role="assistant" data-message-id="exact-answer" data-end-turn="true">Exact answer</div><div data-message-author-role="user" data-message-id="later-user">Fixture question</div><div data-message-author-role="assistant" data-message-id="later-answer" data-end-turn="true">Do not attach this answer</div>';
    };});
    t.mock.method(page,'bringToFront',async()=>{throw new Error('No focus allowed');});
    const latest=async(requestId:string)=>invokeMcpTool({name:'sessionplane_decide',arguments:{teamId:team.teamId,requestRef:row.outbox_id,requestId,decision:'latest'},socketPath:config.socketPath,timeoutMs:5000,maxLineBytes:config.rpcMaxLineBytes});
    await page.locator('textarea').fill('Preserved user draft');
    const blocked=await latest('draft-protected');
    assert.equal(blocked.isError,false,JSON.stringify(blocked));
    assert.equal(blocked.structuredContent.displayOutcome,'not-dispatched');
    assert.equal(await page.locator('textarea').inputValue(),'Preserved user draft');
    await page.locator('textarea').fill('');
    await page.evaluate(()=>{(document.activeElement as HTMLElement).blur();const range=document.createRange();range.selectNodeContents(document.querySelector('#history')!);getSelection()!.removeAllRanges();getSelection()!.addRange(range);});
    assert.equal(await page.evaluate(()=>getSelection()!.isCollapsed),false);
    assert.equal((await latest('selection-protected')).structuredContent.displayOutcome,'not-dispatched');
    await page.evaluate(()=>{getSelection()!.removeAllRanges();const b=document.createElement('button');b.dataset.testid='stop-button';b.id='active-stop';b.textContent='Stop generating';document.querySelector('main')!.append(b);});
    assert.equal((await latest('active-protected')).structuredContent.displayOutcome,'not-dispatched');
    await page.locator('#active-stop').evaluate(e=>e.remove());
    const displayed=await latest('explicit-display');
    assert.equal(displayed.isError,false,JSON.stringify(displayed));
    assert.equal(displayed.structuredContent.displayTarget,'submitted-anchor');
    assert.equal(displayed.structuredContent.displayOutcome,'clicked');
    assert.equal(displayed.structuredContent.anchorPresent,true);
    assert.equal(displayed.structuredContent.responseMessageId,null);
    assert.deepEqual((await latest('explicit-display')).structuredContent,displayed.structuredContent);
    assert.equal(await page.locator('button').getAttribute('data-clicks'),'1');
    const dom=await observeChatGptDom(page,{submittedUserMessageId:'user-message-1',submittedUserTurnId:'user-turn-1'});
    assert.equal(dom.candidate?.responseMessageId,'exact-answer');
    assert.equal(dom.candidate?.answerText,'Exact answer');
    await page.locator('#history').evaluate(host=>{
      const html=host.innerHTML;host.innerHTML='';
      host.attachShadow({mode:'open'}).innerHTML=html+'<button data-testid="stop-button">Stop generating</button>';
    });
    await page.locator('textarea').fill('Preserved shadow-read draft');
    const shadow=await latest('shadow-read-only');
    assert.equal(shadow.isError,false,JSON.stringify(shadow));
    assert.equal(shadow.structuredContent.displayOutcome,'already-present');
    assert.equal(shadow.structuredContent.anchorPresent,true);
    assert.equal(await page.locator('textarea').inputValue(),'Preserved shadow-read draft');
    assert.equal(await page.locator('button[aria-label="Scroll to bottom"]').getAttribute('data-clicks'),'1');
    assert.equal(await page.locator('[data-testid="stop-button"]').count(),1);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(session.sessionId),row);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(session.sessionId),generation);
    assert.equal(fake.submitCount,1);
    assert.equal(navigations,1);
  } finally {await core.close();rmSync(root,{recursive:true,force:true});}
});
