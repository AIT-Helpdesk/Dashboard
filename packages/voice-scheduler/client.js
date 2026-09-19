export const id = 'voice-scheduler';
export const label = 'Voice Scheduler';

// No module-level state (unlike e.g. CSP Customers' lastData) -- this is a
// live, in-progress conversation, not cached data worth restoring across a
// nav-away-and-back. Every mount() starts fresh, and any live
// MediaRecorder/stream from a previous mount is torn down on unmount (see
// the cleanup registered below) rather than left running in the background.

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4', // Safari/WebKit (incl. every iPhone browser, which is WebKit under the hood) -- doesn't support audio/webm
  'audio/mpeg',
  'audio/wav',
];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function extensionFor(mimeType) {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

function speak(text) {
  if (!text || typeof speechSynthesis === 'undefined') return;
  try {
    speechSynthesis.cancel(); // don't stack a new question behind an unfinished one
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // TTS is a nicety here, not load-bearing -- the same text is always
    // shown on screen too, so a browser that rejects this just stays silent.
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Splits the model's "YYYY-MM-DDTHH:mm:ss" into the separate <input
// type="date">/<input type="time"> values the confirm step's editable
// fields use, and back again -- kept as two small pure functions rather
// than a date library, since this is the only place on this page that
// needs it and the shape is fixed (see server.js's own systemPrompt()).
function splitIso(iso) {
  const [date, time] = String(iso || '').split('T');
  return { date: date || '', time: (time || '').slice(0, 5) };
}
function joinIso(date, time) {
  return `${date}T${time}:00`;
}

export function mount(container) {
  container.innerHTML = `
    <style>
      .vs-log { display: flex; flex-direction: column; gap: 0.6rem; margin: 1.2rem 0; max-width: 40rem; }
      .vs-bubble { padding: 0.6rem 0.9rem; border-radius: 10px; max-width: 85%; line-height: 1.4; }
      .vs-bubble--assistant { background: var(--card); border: 1px solid var(--border); align-self: flex-start; }
      .vs-bubble--user { background: var(--accent, #2563eb); color: #fff; align-self: flex-end; }
      .vs-controls { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin: 1.2rem 0; }
      .vs-mic-button {
        width: 4.5rem; height: 4.5rem; border-radius: 50%; border: none; cursor: pointer;
        background: var(--accent, #2563eb); color: #fff; font-size: 1.6rem; display: flex;
        align-items: center; justify-content: center; transition: transform 0.15s ease;
      }
      .vs-mic-button:disabled { opacity: 0.5; cursor: not-allowed; }
      .vs-mic-button--recording { background: #b91c1c; animation: vs-pulse 1.2s infinite; }
      @keyframes vs-pulse { 0% { transform: scale(1); } 50% { transform: scale(1.08); } 100% { transform: scale(1); } }
      .vs-hint { color: var(--muted); font-size: 0.85rem; }
      .vs-textfallback { display: flex; gap: 0.5rem; max-width: 32rem; margin-top: 0.4rem; }
      .vs-textfallback input { flex: 1; padding: 0.5rem 0.7rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card); }
      .vs-confirm { max-width: 32rem; border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.2rem; margin-top: 1rem; }
      .vs-confirm h3 { margin: 0 0 0.8rem; }
      .vs-field-row { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.7rem; }
      .vs-field-row label { font-size: 0.8rem; color: var(--muted); }
      .vs-field-row input { padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card); }
      .vs-field-pair { display: flex; gap: 0.6rem; }
      .vs-field-pair > div { flex: 1; }
      .vs-confirm-actions { display: flex; gap: 0.6rem; margin-top: 0.8rem; }
    </style>
    <header class="page-header">
      <h1>Voice Scheduler</h1>
    </header>
    <p class="vs-hint">Tap the microphone and speak -- e.g. "Dinner with Kylie today at 6:30pm". It'll ask if anything's missing, then add it to your own calendar once you confirm.</p>
    <div class="vs-log" id="vs-log"></div>
    <div class="vs-controls">
      <button type="button" id="vs-mic" class="vs-mic-button" title="Tap to talk">&#127908;</button>
      <span class="status" id="vs-status">Tap the microphone to start.</span>
    </div>
    <div class="vs-textfallback">
      <input type="text" id="vs-text-input" placeholder="...or type instead" />
      <button type="button" id="vs-text-send">Send</button>
    </div>
    <div id="vs-confirm-area"></div>
  `;

  const logEl = container.querySelector('#vs-log');
  const micButton = container.querySelector('#vs-mic');
  const statusEl = container.querySelector('#vs-status');
  const textInput = container.querySelector('#vs-text-input');
  const textSend = container.querySelector('#vs-text-send');
  const confirmArea = container.querySelector('#vs-confirm-area');

  // { role: 'assistant' | 'user', text }[] -- sent in full on every /converse
  // call (see that route's own comment in server.js for why it's stateless
  // server-side instead).
  let history = [];
  let mediaRecorder = null;
  let mediaStream = null;
  let busy = false; // guards against overlapping turns (e.g. a stray double-tap)
  // True once the confirm screen is showing -- while true, the NEXT recorded
  // clip is treated as a spoken yes/no answer to "add this to your
  // calendar?" instead of another conversation turn sent to /converse (see
  // handleRecordedClip below).
  let awaitingConfirmVoice = false;

  function addBubble(role, text) {
    const div = document.createElement('div');
    div.className = `vs-bubble vs-bubble--${role}`;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'status error' : 'status';
  }

  function setBusy(next) {
    busy = next;
    micButton.disabled = next;
    textSend.disabled = next;
  }

  async function sendTurn(userText) {
    history.push({ role: 'user', text: userText });
    addBubble('user', userText);
    setBusy(true);
    setStatus('Thinking...');
    confirmArea.innerHTML = '';
    try {
      const res = await fetch('/api/voice-scheduler/converse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      if (data.done) {
        history.push({ role: 'assistant', text: data.confirmation });
        addBubble('assistant', data.confirmation);
        const askText = 'Should I add this to your calendar?';
        addBubble('assistant', askText);
        // ONE speak() call for both sentences, not two -- speak() cancels
        // whatever's still playing before starting the next utterance (see
        // its own comment), so two separate calls back-to-back would cut
        // the first sentence off rather than queue after it.
        speak(`${data.confirmation} ${askText}`);
        awaitingConfirmVoice = true;
        setStatus('Say "yes" to add it, or edit the details below.');
        renderConfirm(data.event);
      } else {
        history.push({ role: 'assistant', text: data.question });
        addBubble('assistant', data.question);
        speak(data.question);
        setStatus('Tap the microphone to answer.');
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  function renderConfirm(event) {
    const { date: startDate, time: startTime } = splitIso(event.start);
    const { date: endDate, time: endTime } = splitIso(event.end);
    confirmArea.innerHTML = `
      <div class="vs-confirm">
        <h3>Add to your calendar?</h3>
        <div class="vs-field-row">
          <label for="vs-subject">Title</label>
          <input type="text" id="vs-subject" value="${escapeHtml(event.subject || '')}" />
        </div>
        <div class="vs-field-pair">
          <div class="vs-field-row">
            <label for="vs-start-date">Date</label>
            <input type="date" id="vs-start-date" value="${escapeHtml(startDate)}" />
          </div>
          <div class="vs-field-row">
            <label for="vs-start-time">Start</label>
            <input type="time" id="vs-start-time" value="${escapeHtml(startTime)}" />
          </div>
          <div class="vs-field-row">
            <label for="vs-end-time">End</label>
            <input type="time" id="vs-end-time" value="${escapeHtml(endTime)}" />
          </div>
        </div>
        <div class="vs-field-row">
          <label for="vs-location">Location (optional)</label>
          <input type="text" id="vs-location" value="${escapeHtml(event.location || '')}" />
        </div>
        <div class="vs-confirm-actions">
          <button type="button" id="vs-confirm-btn">Add to Calendar</button>
          <button type="button" id="vs-startover-btn">Start Over</button>
        </div>
      </div>
    `;

    confirmArea.querySelector('#vs-confirm-btn').addEventListener('click', confirmEvent);
    confirmArea.querySelector('#vs-startover-btn').addEventListener('click', startOver);
  }

  // Shared by both the "Add to Calendar" button and a spoken "yes" at the
  // confirm step (see handleConfirmVoiceAnswer below) -- always reads
  // whatever's CURRENTLY in the editable fields, not the model's original
  // parse, so a manual correction typed into a field is respected exactly
  // the same way whether the write is triggered by tapping the button or
  // by voice.
  async function confirmEvent() {
    const subject = confirmArea.querySelector('#vs-subject').value.trim();
    const startDateVal = confirmArea.querySelector('#vs-start-date').value;
    const startTimeVal = confirmArea.querySelector('#vs-start-time').value;
    const endTimeVal = confirmArea.querySelector('#vs-end-time').value;
    const location = confirmArea.querySelector('#vs-location').value.trim();
    if (!subject || !startDateVal || !startTimeVal || !endTimeVal) {
      setStatus('Title, date, start and end time are all required.', true);
      return;
    }
    setBusy(true);
    setStatus('Adding to your calendar...');
    try {
      const res = await fetch('/api/voice-scheduler/create-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject,
          start: joinIso(startDateVal, startTimeVal),
          end: joinIso(startDateVal, endTimeVal),
          location: location || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      confirmArea.innerHTML = `<p class="status">Added to your calendar. <a href="${escapeHtml(data.webLink)}" target="_blank" rel="noopener">Open in Outlook</a></p>`;
      setStatus('Tap the microphone to add another.');
      speak('Added to your calendar.');
      history = [];
      awaitingConfirmVoice = false;
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    history = [];
    awaitingConfirmVoice = false;
    confirmArea.innerHTML = '';
    logEl.innerHTML = '';
    setStatus('Tap the microphone to start.');
  }

  // Loose, forgiving matches rather than requiring an exact "yes"/"no" --
  // this is transcribed speech, so "yep", "that's right", "go ahead" etc.
  // all need to land as an affirmative the same way a typed "yes" would.
  // Deliberately returns null (neither) for anything else, INCLUDING a
  // correction like "change it to 7pm" -- this step only ever acts on a
  // clear yes/no; a correction goes through the editable fields instead
  // (see the vs-hint status message handleConfirmVoiceAnswer sets below).
  function classifyYesNo(text) {
    const t = text.toLowerCase();
    if (/\b(yes|yeah|yep|yup|correct|confirm|do it|sounds good|go ahead|please do|that's right|thats right)\b/.test(t)) return 'yes';
    if (/\b(no|nope|nah|cancel|don't|do not|stop|wrong)\b/.test(t)) return 'no';
    return null;
  }

  async function handleConfirmVoiceAnswer(text) {
    addBubble('user', text);
    const verdict = classifyYesNo(text);
    if (verdict === 'yes') {
      await confirmEvent();
    } else if (verdict === 'no') {
      addBubble('assistant', 'No worries, starting over.');
      speak('No worries, starting over.');
      startOver();
    } else {
      setStatus('Didn\'t catch a yes or no -- say "yes" to add it, or edit the details below and tap Add to Calendar.', true);
    }
  }

  async function startRecording() {
    if (busy) return;
    const mimeType = pickMimeType();
    if (mimeType === null) {
      setStatus('This browser cannot record audio. Use the text box below instead.', true);
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setStatus('Microphone access was denied or is unavailable. Use the text box below instead.', true);
      return;
    }
    const chunks = [];
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
      const actualType = mediaRecorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: actualType });
      await handleRecordedClip(blob, actualType);
    };
    mediaRecorder.start();
    micButton.classList.add('vs-mic-button--recording');
    micButton.innerHTML = '&#9632;'; // stop square
    setStatus('Listening... tap again to stop.');
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    micButton.classList.remove('vs-mic-button--recording');
    micButton.innerHTML = '&#127908;';
  }

  async function handleRecordedClip(blob, mimeType) {
    setBusy(true);
    setStatus('Transcribing...');
    try {
      const form = new FormData();
      form.append('audio', blob, `clip.${extensionFor(mimeType)}`);
      const res = await fetch('/api/voice-scheduler/transcribe', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const text = (data.text || '').trim();
      if (!text) {
        setStatus("Didn't catch that -- tap the microphone and try again.", true);
        setBusy(false);
        return;
      }
      setBusy(false);
      if (awaitingConfirmVoice) await handleConfirmVoiceAnswer(text);
      else await sendTurn(text);
    } catch (err) {
      setBusy(false);
      setStatus(`Error: ${err.message}`, true);
    }
  }

  micButton.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
    else startRecording();
  });

  textSend.addEventListener('click', () => {
    const text = textInput.value.trim();
    if (!text || busy) return;
    textInput.value = '';
    if (awaitingConfirmVoice) handleConfirmVoiceAnswer(text);
    else sendTurn(text);
  });
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') textSend.click();
  });

  // The shell fully tears down a page's DOM on navigating away (see CSP
  // Customers' own client.js comment on this) but doesn't call any
  // explicit per-page teardown hook -- so a live mic stream/recorder is
  // stopped here, the one moment this module still definitely has a
  // reference to it, rather than relying on garbage collection to release
  // the microphone.
  new MutationObserver(() => {
    if (!document.body.contains(container)) {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    }
  }).observe(document.body, { childList: true, subtree: true });
}
