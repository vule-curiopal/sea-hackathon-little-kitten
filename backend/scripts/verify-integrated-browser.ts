import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Real browser controls and real HTTP/provider replies; no routes are mocked. */
export async function verifyIntegratedBrowser(baseUrl: string, outputDirectory: string): Promise<Record<string, unknown>> {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  let currentStage = 'launch';
  const stages: { stage: string; at: string }[] = [];
  const http: Record<string, unknown>[] = [];
  const completedChecks: string[] = [];
  const stage = (value: string) => { currentStage = value; stages.push({ stage: value, at: new Date().toISOString() }); };
  const requestStarts = new WeakMap<import('playwright').Request, { stage: string; at: number }>();
  const captures = new Set<Promise<void>>();
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requestStarts.set(request, { stage: currentStage, at: performance.now() }); });
  page.on('pageerror', error => errors.push(error.name));
  let session: { session_id: string; demo_token: string } | undefined;
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/')) {
      const work = (async () => {
        const started = requestStarts.get(response.request());
        let errorCode: string | null = null;
        if (!response.ok()) {
          try { const data = await response.json(); if (typeof data.error?.code === 'string' && /^[a-z0-9_]{1,80}$/u.test(data.error.code)) errorCode = data.error.code; } catch { /* Never record raw bodies. */ }
        }
        http.push({ method: response.request().method(), path, status: response.status(), stage: started?.stage ?? currentStage,
          elapsed_ms: started ? Math.round(performance.now() - started.at) : null, error_code: errorCode });
      })().catch(() => {});
      captures.add(work); void work.finally(() => captures.delete(work));
    }
    if (new URL(response.url()).pathname === '/api/sessions' && response.request().method() === 'POST' && response.ok()) {
      void response.json().then(value => { session = value; }).catch(() => undefined);
    }
  });
  const check = (passed: unknown, code: string): void => { if (!passed) throw new Error(code); };
  const panel = async (): Promise<any> => {
    check(session, 'browser_missing_session');
    const token = session!.demo_token;
    return page.evaluate(async credential => {
      const response = await fetch('/api/demo/panel', { headers: { Authorization: `Bearer ${credential}` } });
      if (!response.ok) throw new Error('browser_panel_request_failed');
      return response.json();
    }, token);
  };
  const isTurn = (url: string) => /^\/api\/sessions\/[^/]+\/turns$/u.test(new URL(url).pathname);
  const isCompleted = (response: import('playwright').Response) => {
    if (!response.ok() || response.request().method() !== 'POST' || !response.url().endsWith('/playback')) return false;
    try { return response.request().postDataJSON()?.status === 'completed'; } catch { return false; }
  };
  try {
    stage('initial_session');
    await page.goto(baseUrl + '/app/talk', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Say hello', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.microphone-button')?.disabled);
    stage('text_only_settings');
    await page.locator('.talk-header button').click();
    await page.locator('#sound').uncheck();
    await page.locator('dialog[open] .dialog-done').click();
    await page.locator('button[aria-controls="conversation-panel"]').click();
    stage('typed_reply');
    await page.locator('#message').fill('My toy is named Nori.');
    const textResponse = page.waitForResponse(response => response.request().method() === 'POST' && isTurn(response.url()), { timeout: 120_000 });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const textHttp = await textResponse;
    const text = await textHttp.json();
    check(textHttp.ok() && text.provider_mode === 'real' && text.engine_mode === 'character_memory', 'browser_text_not_real_integrated');
    check(text.audio === null && text.input_mode === 'text', 'browser_text_only_not_honest');
    await page.getByRole('button', { name: 'Done reading', exact: true }).last().waitFor({ timeout: 30_000 });
    stage('before_reading');
    const before = await panel();
    check(!before.context.entities.some((entity: any) => entity.name === 'Nori'), 'browser_text_learned_before_reading');
    stage('reading_acknowledgment');
    const readReceipt = page.waitForResponse(isCompleted, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Done reading', exact: true }).last().click();
    await readReceipt;
    const after = await panel();
    check(after.context.entities.some((entity: any) => entity.name === 'Nori'), 'browser_visible_delivery_not_learned');
    completedChecks.push('visible_delivery_gates_learning');
    await page.screenshot({ path: resolve(output, 'conversation.png'), fullPage: true });

    stage('memory_panel');
    await page.locator('button[aria-controls="conversation-panel"]').click();
    await page.getByRole('button', { name: 'Adult demo panel', exact: true }).click();
    await page.getByRole('heading', { name: 'Names & characters' }).waitFor();
    await page.getByRole('dialog').filter({ has: page.getByText('Names & characters', { exact: true }) }).getByText('Nori', { exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, 'memory-panel.png'), fullPage: true });
    completedChecks.push('memory_panel_uses_postgresql_state');
    stage('next_day_http');
    const freshSession = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions', { timeout: 120_000 });
    const freshConfig = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/profiles/current/config', { timeout: 120_000 });
    void freshSession.catch(() => {}); void freshConfig.catch(() => {});
    const previousSessionId = session!.session_id;
    const dayResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/demo/next-day', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Next day', exact: true }).click();
    check((await dayResponse).ok(), 'browser_next_day_failed');
    stage('next_day_fresh_session_and_configuration');
    const reopened = await freshSession;
    check(reopened.ok() && (await freshConfig).ok(), 'browser_next_day_reconnect_failed');
    session = await reopened.json();
    check(session!.session_id !== previousSessionId, 'browser_next_day_reused_closed_session');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.microphone-button')?.disabled);
    stage('next_day_retained_memory');
    const next = await panel();
    check(next.context.daily.growthDays === after.context.daily.growthDays + 1, 'browser_growth_not_advanced');
    check(next.context.entities.some((entity: any) => entity.name === 'Nori'), 'browser_next_day_lost_memory');
    completedChecks.push('next_day_retains_memory');
    await page.locator('dialog[open] .dialog-heading button').click();

    stage('audio_settings');
    await page.locator('.talk-header button').click();
    await page.locator('#sound').check();
    await page.locator('dialog[open] .dialog-done').click();
    await page.locator('button[aria-controls="conversation-panel"]').click();
    stage('actual_model_and_output_tts');
    await page.locator('#message').fill('Hello.');
    const audioResponse = page.waitForResponse(response => response.request().method() === 'POST' && isTurn(response.url()), { timeout: 120_000 });
    const audibleReceipt = page.waitForResponse(isCompleted, { timeout: 150_000 });
    void audibleReceipt.catch(() => {});
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const audioHttp = await audioResponse;
    const audio = await audioHttp.json();
    check(audioHttp.ok() && audio.provider_mode === 'real' && !!audio.audio?.data_base64, 'browser_real_audio_missing');
    completedChecks.push('real_output_tts');
    stage('html_audio_completed_receipt');
    // Some browsers require an additional gesture after the asynchronous model call.
    const play = page.getByRole('button', { name: 'Play answer', exact: true }).last();
    await Promise.race([audibleReceipt, play.waitFor({ state: 'visible', timeout: 20_000 }).then(() => play.click()).catch(() => undefined)]);
    await audibleReceipt;
    completedChecks.push('real_tts_html_audio_completed_receipt');
    await page.screenshot({ path: resolve(output, 'approved-audio.png'), fullPage: true });
    check(errors.length === 0, 'browser_runtime_error');
    const report = {
      status: 'passed', provider_mode: 'real', engine_mode: 'character_memory',
      checks: completedChecks, stages, http, audio_input_stt: 'not_in_scope',
      text_reply: text.reply.text, audio_reply: audio.reply.text, growth_days: next.context.daily.growthDays,
      audio_mime_type: audio.audio.mime_type, audio_duration_ms: audio.audio.duration_ms,
      screenshots: ['conversation.png', 'memory-panel.png', 'approved-audio.png'],
      limitations: 'Desktop headless Chrome exercised actual DOM controls and HTML audio events. No physical microphone, speaker, iPad, or child listening was verified.',
    };
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => undefined);
    const value = error instanceof Error ? error : new Error('browser_execution_failed');
    const operation = value.message.split(':', 1)[0] ?? '';
    await writeFile(resolve(output, 'report.json'), JSON.stringify({ status: 'failed', current_stage: currentStage,
      completed_checks: completedChecks, stages, http, audio_input_stt: 'not_in_scope',
      error: { name: value.name, code: /^browser_[a-z0-9_]{1,72}$/u.test(value.message) ? value.message : value.name === 'TimeoutError' ? 'browser_ui_timeout' : 'browser_execution_failed',
        operation: /^[A-Za-z][A-Za-z.]{1,60}$/u.test(operation) ? operation : null,
        locations: [...(value.stack ?? '').matchAll(/(?:file:\/\/)?(\/[^()\n]*\/backend\/scripts\/[\w.-]+\.[cm]?tsx?):(\d+):(\d+)/gu)]
          .map(match => ({ file: match[1], line: Number(match[2]), column: Number(match[3]) })) },
      limitations: 'Uncompleted stages remain unresolved. No incoming STT or physical device playback is established.' }, null, 2) + '\n');
    throw error;
  } finally {
    await browser.close();
    await Promise.allSettled([...captures]);
    await writeFile(resolve(output, 'stages.json'), JSON.stringify({ current_stage: currentStage, stages, completed_checks: completedChecks }, null, 2) + '\n');
    await writeFile(resolve(output, 'http.jsonl'), http.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
}
