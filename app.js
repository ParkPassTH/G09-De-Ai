const overviewDiv = document.getElementById('overview_result');
const detailsDiv = document.getElementById('details_result');
const userCam = document.getElementById('user_cam');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const switchBtn = document.getElementById('switch_cam_btn');
let currentFacing = 'environment'; // default try back camera
let currentStream;
// Tunables (can override in index.html):
// window.UPDATE_MS = 500  // update cadence in ms (default 800)
// window.TARGET_MAX = 480 // max frame side sent to backend (default 480)
// window.JPEG_Q = 0.45    // JPEG quality 0..1 (default 0.45)
const UPDATE_MS = Math.max(200, Number(window.UPDATE_MS) || 500);
const TARGET_MAX = Math.max(160, Number(window.TARGET_MAX) || 480);
const JPEG_Q = Math.min(0.95, Math.max(0.2, Number(window.JPEG_Q) || 0.5));

function renderSummary(data){
  if(!data || !data.overview){ overviewDiv.innerHTML=''; detailsDiv.innerHTML=''; return; }
  const ov = data.overview;

  const makeTagGroup = (title, obj, icon)=>{
    if(!obj || !Object.keys(obj).length) return '';
    let tags = Object.entries(obj)
      .map(([k,v])=>`<div class="tag">${k}<span class="count">${v}</span></div>`)
      .join('');
    return `<div class="group-block"><div class="group-heading">${icon||''}${title}</div><div class="tag-list">${tags}</div></div>`;
  };

  let ovHtml = `
    <h2>📊 ภาพรวมการตรวจ</h2>
    <div class="stat-grid">
      <div class="stat-box"><div class="label">ผลไม้ทั้งหมด</div><div class="value">${ov.total}</div></div>
      <div class="stat-box"><div class="label">ชนิดเกรด</div><div class="value">${Object.keys(ov.grades).length}</div></div>
      <div class="stat-box"><div class="label">ระดับสุก</div><div class="value">${Object.keys(ov.ripeness).length}</div></div>
      <div class="stat-box"><div class="label">ประเภทตำหนิ</div><div class="value">${Object.keys(ov.defects).length}</div></div>
    </div>
    <hr class="divider" />
    ${makeTagGroup('เกรด', ov.grades,'🍽️ ')}
    ${makeTagGroup('ความสุก', ov.ripeness,'🥭 ')}
    ${makeTagGroup('ตำหนิ / โรค', ov.defects,'⚠️ ')}
  `;
  overviewDiv.innerHTML = ovHtml;

  if(data.details && data.details.length){
    let dt = `<h2>รายละเอียดรายลูก</h2>`;
    dt += `<table border="1" style="margin:auto; border-collapse:collapse;">
      <tr><th>#</th><th>ID</th><th>Grade</th><th>Ripeness</th><th>Conf</th><th>Defects</th><th>ตำแหน่ง (box)</th></tr>`;
    data.details.forEach((d,i)=>{
      // Group same defect names and show instance count instead of confidence
      let defects = '-';
      if(d.defects && d.defects.length){
        const counts = d.defects.reduce((acc, df)=>{ acc[df.name] = (acc[df.name]||0) + 1; return acc; }, {});
        defects = Object.entries(counts).map(([name,count])=>`${name} (${count})`).join('<br>');
      }
      dt += `<tr>
        <td>${i+1}</td>
        <td>${d.id ?? '-'}</td>
  <td>${d.grade ?? '-'}</td>
  <td>${d.ripeness ?? '-'}</td>
  <td>${d.ripeness_confidence ?? '-'}</td>
        <td>${defects}</td>
        <td>[${d.box.join(', ')}]</td>
      </tr>`;
    });
    dt += `</table>`;
    detailsDiv.innerHTML = dt;
  } else {
    detailsDiv.innerHTML = '';
  }
}

const API_BASE = window.API_BASE || (window.location.origin.includes('vercel.app') ? (window.API_BASE_FALLBACK || '') : '');

function apiUrl(path){
  if(!API_BASE) return path;
  return API_BASE.replace(/\/$/,'') + path;
}

function pollLatest(){
  fetch(apiUrl('/latest_summary'))
    .then(r=>r.json())
    .then(renderSummary)
    .catch(e=>console.warn('poll error',e));
}
if(userCam){
  // Deploy mode: capture user webcam and send frames to /predict
  async function stopStream(){
    if(currentStream){
      try { currentStream.getTracks().forEach(t=>t.stop()); } catch(_) {}
      currentStream = null;
    }
  }
  async function initCam(facing = currentFacing){
    try{
      if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        throw new Error('mediaDevices not supported');
      }
      // Prefer facing if supported
      const constraintsPrimary = { video: { facingMode: { ideal: facing } } };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraintsPrimary);
      } catch(err){
        // Fallback: choose device manually
        const devices = await navigator.mediaDevices.enumerateDevices();
        const vids = devices.filter(d=>d.kind==='videoinput');
        let target = vids.find(d=> facing==='environment' ? /back|rear|environment/i.test(d.label) : /front|user|face/i.test(d.label));
        if(!target && vids.length){ target = vids[0]; }
        if(!target) throw err;
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: target.deviceId } } });
      }
      await stopStream();
      currentStream = stream;
      userCam.srcObject = stream;
      currentFacing = facing;
      if(statusEl) statusEl.textContent = 'Camera '+(facing==='environment'?'(back)':'(front)')+' ready';
    }catch(e){
      if(statusEl) statusEl.textContent = 'Camera error: '+e.message;
      // Try fallback front camera if back failed
      if(facing==='environment'){
        try{ await initCam('user'); }catch(_){}
      }
    }
  }
  if(switchBtn){
    switchBtn.addEventListener('click', ()=>{
      const next = currentFacing==='environment' ? 'user' : 'environment';
      initCam(next);
    });
  }
  async function sendFrame(){
    if(userCam.readyState >= 2){
      const canvas = sendFrame._c || (sendFrame._c = document.createElement('canvas'));
      canvas.width = userCam.videoWidth;
      canvas.height = userCam.videoHeight;
      const ctx = canvas.getContext('2d');
  // downscale if very large to reduce upload size
  const targetMax = TARGET_MAX;
      let dw = userCam.videoWidth, dh = userCam.videoHeight;
      if(Math.max(dw,dh) > targetMax){
        const sc = targetMax / Math.max(dw,dh);
        canvas.width = Math.round(dw*sc);
        canvas.height = Math.round(dh*sc);
      }
      ctx.drawImage(userCam,0,0,canvas.width,canvas.height);
  const dataURL = canvas.toDataURL('image/jpeg', JPEG_Q); // lower quality for bandwidth
      try{
  const res = await fetch(apiUrl('/predict'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:dataURL})});
        if(res.ok){
          const json = await res.json();
          renderSummary(json);
          // draw boxes if overlay present
          if(overlay && sendFrame._c){
            // Display size (what user sees)
            const dispW = userCam.clientWidth || userCam.videoWidth || sendFrame._c.width;
            const dispH = userCam.clientHeight || userCam.videoHeight || sendFrame._c.height;
            overlay.width = dispW;
            overlay.height = dispH;
            // Inference size (what we sent to backend)
            const infW = sendFrame._c.width;
            const infH = sendFrame._c.height;
            const sx = dispW / infW;
            const sy = dispH / infH;
            const octx = overlay.getContext('2d');
            octx.clearRect(0,0,dispW,dispH);
            const boxes = json.raw || [];
            boxes.forEach(b=>{
              let [x1,y1,x2,y2] = b.box;
              x1*=sx; y1*=sy; x2*=sx; y2*=sy;
              const w = x2 - x1; const h = y2 - y1;
              octx.strokeStyle = '#ffb300';
              octx.lineWidth = 2;
              octx.strokeRect(x1,y1,w,h);
              const label = `${b.class} ${b.confidence}`;
              octx.font = '14px sans-serif';
              const pad = 4;
              const metrics = octx.measureText(label);
              const tw = metrics.width;
              const th = 16;
              octx.fillStyle = 'rgba(255,179,0,0.85)';
              const boxY = Math.max(0,y1-th-4);
              octx.fillRect(x1, boxY, tw+pad*2, th+4);
              octx.fillStyle = '#000';
              octx.fillText(label, x1+pad, boxY+th);
            });
          }
          if(statusEl) statusEl.textContent = 'Updated '+new Date().toLocaleTimeString();
          sendFrame._delay = UPDATE_MS; // normal cadence
        } else {
          if(res.status === 429){
            if(statusEl) statusEl.textContent = 'Server busy, backing off';
            sendFrame._delay = Math.max(UPDATE_MS * 2, 2000); // backoff
          } else {
            if(statusEl) statusEl.textContent = 'Predict error '+res.status;
            sendFrame._delay = Math.max(UPDATE_MS * 1.5, 1200);
          }
        }
      }catch(e){
        if(statusEl) statusEl.textContent = 'Network error '+e.message;
        sendFrame._delay = Math.min(4000, (sendFrame._delay||UPDATE_MS)*1.5);
      }
    }
    setTimeout(sendFrame, sendFrame._delay || UPDATE_MS);
  }
  initCam();
  sendFrame();
} else {
  // Local dev: poll summary
  setInterval(pollLatest, Math.min(UPDATE_MS, 1000));
  pollLatest();
}
