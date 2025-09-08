// client.js (fixed — bidirectional, robust chunk framing, no hashing)
console.log("client.js — robust P2P file transfer (no hashing)");

// --- Signaling socket (unchanged) ---
const socket = io();

// --- Globals ---
let pc = null;
let dataChannel = null;
let receiving = {
  active: false,
  meta: null,        // { fileName, fileSize, chunkSize, fileType, totalChunks }
  chunks: new Map(), // Map<chunkIndex, ArrayBuffer>
  receivedBytes: 0
};

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

// Chunk framing constants
const CHUNK_HEADER_BYTES = 12; // 4 bytes magic + 4 bytes index + 4 bytes length
const CHUNK_MAGIC = 0x46494C45; // 'FILE' in ASCII

// --- Utilities ---
function log(msg) {
  console.log(msg);
  appendMessage(`[DEBUG] ${msg}`);
}
function appendMessage(msg) {
  const chatBox = document.getElementById("chatBox");
  if (!chatBox) return;
  const ts = new Date().toLocaleTimeString();
  chatBox.innerHTML += `<span style="color:#666;font-size:0.8em;">[${ts}]</span> ${msg}<br>`;
  chatBox.scrollTop = chatBox.scrollHeight;
}
function formatFileSize(n) {
  if (n === 0) return "0 B";
  const units = ["B","KB","MB","GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

// Cleanly close existing connection (to avoid leaks)
function resetConnection() {
  if (dataChannel) {
    try { dataChannel.close(); } catch(e){}
    dataChannel = null;
  }
  if (pc) {
    try { pc.close(); } catch(e){}
    pc = null;
  }
  receiving = { active: false, meta: null, chunks: new Map(), receivedBytes: 0 };
}

// --- Create / start connection (caller/offerer) ---
document.getElementById("startBtn").onclick = async () => {
  log("Start clicked — creating PeerConnection");
  try {
    resetConnection();
    pc = new RTCPeerConnection(RTC_CONFIG);

    // create reliable ordered datachannel (no maxRetransmits)
    dataChannel = pc.createDataChannel("filetransfer", { ordered: true });
    setupDataChannelHandlers();

    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit("candidate", ev.candidate);
    };
    pc.onconnectionstatechange = () => {
      log(`PC state: ${pc.connectionState}`);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", offer);
    appendMessage("Offer created & sent to signaling server.");
  } catch (err) {
    log("Start error: " + err.message);
  }
};

// --- Handle incoming offer (answerer) ---
socket.on("offer", async (offer) => {
  log("Received offer — answering");
  try {
    resetConnection();
    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.ondatachannel = (ev) => {
      dataChannel = ev.channel;
      setupDataChannelHandlers();
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit("candidate", ev.candidate);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", answer);
    appendMessage("Answer created & sent.");
  } catch (err) {
    log("Offer handling error: " + err.message);
  }
});

// --- Handle incoming answer ---
socket.on("answer", async (answer) => {
  try {
    if (!pc) { log("No pc when answer arrived"); return; }
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    appendMessage("Connection established (answer applied).");
  } catch (err) {
    log("Error applying answer: " + err.message);
  }
});

// --- ICE candidates ---
socket.on("candidate", async (candidate) => {
  try {
    if (!pc) { log("candidate received but no pc yet"); return; }
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    log("addIceCandidate error: " + err.message);
  }
});

socket.on('connect', () => log('Signaling socket connected'));
socket.on('disconnect', () => log('Signaling socket disconnected'));

// --- Data channel helpers ---
function setupDataChannelHandlers() {
  if (!dataChannel) return;
  dataChannel.onopen = () => {
    log("DataChannel open");
    appendMessage("✅ Data channel ready — you can send files.");
  };
  dataChannel.onclose = () => {
    log("DataChannel closed");
    appendMessage("❌ Data channel closed");
  };
  dataChannel.onerror = (err) => {
    log("DataChannel error: " + (err && err.message ? err.message : err));
  };

  dataChannel.onmessage = async (event) => {
    try {
      // If string => JSON control message (chat, file_start, file_end)
      if (typeof event.data === "string") {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { appendMessage("Peer: " + event.data); return; }
        if (msg.type === "chat") {
          appendMessage("Peer: " + msg.message);
        } else if (msg.type === "file_start") {
          // start new receive session
          receiving.active = true;
          receiving.meta = {
            fileName: msg.fileName,
            fileSize: msg.fileSize,
            chunkSize: msg.chunkSize || 64*1024,
            fileType: msg.fileType || "application/octet-stream",
            totalChunks: Math.ceil(msg.fileSize / (msg.chunkSize || 64*1024))
          };
          receiving.chunks = new Map();
          receiving.receivedBytes = 0;
          appendMessage(`📥 Receiving ${receiving.meta.fileName} (${formatFileSize(receiving.meta.fileSize)})`);
          document.getElementById("fileStatus").innerText = `Receiving ${receiving.meta.fileName}... 0%`;
        } else if (msg.type === "file_end") {
          log("file_end received — assembling");
          await finalizeReceive();
        } else {
          log("Unknown control message: " + JSON.stringify(msg));
        }
        return;
      }

      // Binary data: could be Blob or ArrayBuffer
      let arrayBuffer;
      if (event.data instanceof Blob) {
        arrayBuffer = await event.data.arrayBuffer();
      } else if (event.data instanceof ArrayBuffer) {
        arrayBuffer = event.data;
      } else {
        log("Unknown binary message type");
        return;
      }

      // handle framed chunk
      handleFramedChunk(arrayBuffer);

    } catch (err) {
      log("onmessage error: " + err.message);
    }
  };
}

// --- Chunk handling & reassembly ---
function handleFramedChunk(arrayBuffer) {
  if (!receiving.active) {
    log("Received binary while not expecting a file — ignoring");
    return;
  }
  if (arrayBuffer.byteLength < CHUNK_HEADER_BYTES) {
    log("Chunk too small for header — ignoring");
    return;
  }

  const dv = new DataView(arrayBuffer, 0, CHUNK_HEADER_BYTES);
  const magic = dv.getUint32(0, false); // big-endian
  if (magic !== CHUNK_MAGIC) {
    log("Bad chunk magic — ignoring");
    return;
  }
  const idx = dv.getUint32(4, false);
  const len = dv.getUint32(8, false);

  if (arrayBuffer.byteLength < CHUNK_HEADER_BYTES + len) {
    log(`Chunk ${idx} declared length ${len} but packet shorter (${arrayBuffer.byteLength}) — ignoring`);
    return;
  }

  const chunkData = arrayBuffer.slice(CHUNK_HEADER_BYTES, CHUNK_HEADER_BYTES + len);

  if (!receiving.chunks.has(idx)) {
    receiving.chunks.set(idx, chunkData);
    receiving.receivedBytes += len;
  } else {
    // duplicate chunk — ignore
  }

  // update progress
  const progress = Math.round((receiving.receivedBytes / receiving.meta.fileSize) * 100);
  document.getElementById("fileStatus").innerText = `Receiving ${receiving.meta.fileName}... ${progress}%`;
}

async function finalizeReceive() {
  if (!receiving.active || !receiving.meta) {
    appendMessage("No active transfer to finalize");
    return;
  }

  const meta = receiving.meta;
  const expected = meta.totalChunks;

  // Quick check: do we have all chunks?
  if (receiving.chunks.size !== expected) {
    log(`Chunks: expected ${expected}, received ${receiving.chunks.size}`);
    // But continue to assemble available chunks to avoid silent loss — we warn user
    appendMessage(`⚠️ Transfer ended but missing chunks (got ${receiving.chunks.size}/${expected}). Attempting to assemble anyway.`);
  }

  // assemble in index order
  const parts = [];
  for (let i = 0; i < expected; i++) {
    const c = receiving.chunks.get(i);
    if (c) parts.push(c);
    else {
      // missing chunk — insert a zero-length or stop. We'll break to avoid corrupt file.
      log(`Missing chunk index ${i} — abort assembly`);
      appendMessage(`❌ Missing chunk ${i}. File cannot be assembled correctly.`);
      // Reset receive state
      receiving = { active: false, meta: null, chunks: new Map(), receivedBytes: 0 };
      return;
    }
  }

  const blob = new Blob(parts, { type: meta.fileType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = meta.fileName;
  a.textContent = `📁 Download ${meta.fileName}`;
  a.style.display = "block";
  a.style.margin = "6px 0";
  a.onclick = () => { setTimeout(() => URL.revokeObjectURL(url), 1500); };
  document.getElementById("download").appendChild(a);

  // Complete
  document.getElementById("fileStatus").innerText = `✅ File received: ${meta.fileName}`;
  appendMessage(`📁 File ready: ${meta.fileName} (${formatFileSize(blob.size)})`);

  // reset receiver state
  receiving = { active: false, meta: null, chunks: new Map(), receivedBytes: 0 };
}

// --- File sending (guarded, chunk-framed) ---
document.getElementById("sendFileBtn").onclick = async () => {
  const fileEl = document.getElementById("fileInput");
  if (!fileEl || !fileEl.files || fileEl.files.length === 0) {
    alert("Choose a file first");
    return;
  }
  if (!dataChannel || dataChannel.readyState !== "open") {
    appendMessage("⚠️ Data channel not open yet. Wait a moment and try again.");
    return;
  }

  const file = fileEl.files[0];
  await sendFile(file);
};

async function sendFile(file) {
  try {
    const chunkSize = 64 * 1024; // 64KB
    const totalChunks = Math.ceil(file.size / chunkSize);

    // send metadata
    const meta = {
      type: "file_start",
      fileName: file.name,
      fileSize: file.size,
      chunkSize,
      fileType: file.type || "application/octet-stream"
    };
    dataChannel.send(JSON.stringify(meta));
    log(`Sent file_start for ${file.name}, ${file.size} bytes, ${totalChunks} chunks`);

    // send framed chunks
    let idx = 0;
    let offset = 0;
    const start = Date.now();
    while (offset < file.size) {
      // backpressure
      if (dataChannel.bufferedAmount > 512 * 1024) {
        await new Promise(r => setTimeout(r, 8));
        continue;
      }

      const end = Math.min(offset + chunkSize, file.size);
      const slice = file.slice(offset, end);
      const arrayBuffer = await slice.arrayBuffer();

      // build header + data
      const header = new ArrayBuffer(CHUNK_HEADER_BYTES);
      const dv = new DataView(header);
      dv.setUint32(0, CHUNK_MAGIC, false); // magic big-endian
      dv.setUint32(4, idx, false);
      dv.setUint32(8, arrayBuffer.byteLength, false);

      const combined = new Uint8Array(CHUNK_HEADER_BYTES + arrayBuffer.byteLength);
      combined.set(new Uint8Array(header), 0);
      combined.set(new Uint8Array(arrayBuffer), CHUNK_HEADER_BYTES);

      // send
      dataChannel.send(combined.buffer);

      offset += arrayBuffer.byteLength;
      idx++;

      // progress UI
      const progress = Math.round((offset / file.size) * 100);
      document.getElementById("fileStatus").innerText = `Sending ${file.name}... ${progress}%`;
    }

    // send end marker
    dataChannel.send(JSON.stringify({ type: "file_end", fileName: file.name }));
    const elapsed = (Date.now() - start) / 1000;
    appendMessage(`✅ Sent ${file.name} (${formatFileSize(file.size)}) in ${elapsed.toFixed(1)}s`);
    document.getElementById("fileStatus").innerText = `File sent: ${file.name}`;

  } catch (err) {
    log("sendFile error: " + err.message);
    alert("Error sending file: " + err.message);
  }
}
