
const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const playlistEl = $("playlist");
const emptyState = $("emptyState");
const playButton = $("playButton");
const seekBar = $("seekBar");
const volumeBar = $("volumeBar");
const crossfadeRange = $("crossfadeRange");
const visualizerRange = $("visualizerRange");
const canvas = $("visualizer");
const ctx = canvas.getContext("2d");

let songs = [];
let currentIndex = -1;
let currentDeck = 0;
let shuffle = false;
let repeat = false;
let isSeeking = false;
let audioContext = null;
let decks = [];
let fadeTimer = null;
let fadeToken = 0;
let toastTimer = null;
let animationId = null;

const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

function createAudioEngine() {
  if (audioContext) {
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
    return;
  }

  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    showToast("Your browser does not support Web Audio.");
    return;
  }

  audioContext = new AudioContextClass();

  decks = [0, 1].map(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = 1;

    const source = audioContext.createMediaElementSource(audio);
    const gain = audioContext.createGain();
    const analyser = audioContext.createAnalyser();

    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;

    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(audioContext.destination);

    const deck = {
      audio,
      gain,
      analyser,
      data: new Uint8Array(analyser.frequencyBinCount)
    };

    audio.addEventListener("ended", () => {
      if (decks[currentDeck] === deck) {
        if (repeat && currentIndex >= 0) {
          playSong(currentIndex);
        } else {
          nextSong();
        }
      }
    });

    audio.addEventListener("error", () => {
      if (audio.src && audio.error) {
        showToast("This audio file could not be played.");
      }
    });

    return deck;
  });

  decks[0].gain.gain.value = 1;
  decks[1].gain.gain.value = 0;

  startVisualizer();
}

function resumeAudioContext() {
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume();
  }
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2800);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);

  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function getFileTitle(file) {
  return file.name.replace(/\.[^/.]+$/, "");
}

function addFiles(fileList) {
  const files = Array.from(fileList).filter((file) =>
    file.type.startsWith("audio/") ||
    /\.(mp3|wav|ogg|m4a|aac|flac|opus|weba)$/i.test(file.name)
  );

  if (!files.length) {
    showToast("Choose supported audio files from your device.");
    return;
  }

  const existing = new Set(songs.map((song) =>
    `${song.file.name}|${song.file.size}|${song.file.lastModified}`
  ));

  let added = 0;

  for (const file of files) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;

    if (existing.has(key)) continue;

    existing.add(key);

    songs.push({
      file,
      title: getFileTitle(file),
      url: URL.createObjectURL(file),
      duration: 0
    });

    added++;
  }

  renderPlaylist();

  if (added) {
    showToast(`${added} song${added === 1 ? "" : "s"} added.`);
  }

  if (currentIndex === -1 && songs.length) {
    playSong(0);
  }
}

function renderPlaylist() {
  playlistEl.replaceChildren();
  emptyState.hidden = songs.length > 0;
  $("songCount").textContent = `(${songs.length})`;
  $("clearButton").hidden = songs.length === 0;

  songs.forEach((song, index) => {
    const row = document.createElement("div");
    row.className = "song";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Play ${song.title}`);

    const art = document.createElement("div");
    art.className = "song-art";
    art.textContent = index === currentIndex ? "♫" : "♪";

    const details = document.createElement("div");
    details.className = "song-details";

    const title = document.createElement("strong");
    title.textContent = song.title;

    const artist = document.createElement("span");
    artist.textContent = song.file.name;

    details.append(title, artist);

    const duration = document.createElement("span");
    duration.className = "song-duration";
    duration.textContent = formatTime(song.duration);

    row.append(art, details, duration);

    if (index === currentIndex) {
      row.classList.add("active");
    }

    row.addEventListener("click", () => playSong(index));

    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        playSong(index);
      }
    });

    playlistEl.append(row);

    // Read song duration without starting playback.
    if (!song.duration) {
      const probe = document.createElement("audio");
      probe.preload = "metadata";
      probe.src = song.url;

      probe.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(probe.duration)) {
          song.duration = probe.duration;
          duration.textContent = formatTime(song.duration);
        }
        probe.removeAttribute("src");
        probe.load();
      }, { once: true });

      probe.addEventListener("error", () => {
        probe.removeAttribute("src");
      }, { once: true });
    }
  });
}

function cancelPreviousFade() {
  fadeToken++;

  if (fadeTimer !== null) {
    clearTimeout(fadeTimer);
    fadeTimer = null;
  }

  if (!audioContext || !decks.length) return;

  // Stop both decks' previous gain automation.
  for (const deck of decks) {
    const param = deck.gain.gain;
    param.cancelScheduledValues(audioContext.currentTime);
  }
}

function setGain(deck, value, duration = 0) {
  const param = deck.gain.gain;
  const now = audioContext.currentTime;

  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);

  if (duration > 0) {
    param.linearRampToValueAtTime(
      value,
      now + duration
    );
  } else {
    param.setValueAtTime(value, now);
  }
}

async function playSong(index) {
  if (index < 0 || index >= songs.length) return;

  createAudioEngine();
  if (!audioContext) return;

  resumeAudioContext();
  cancelPreviousFade();

  const previousDeck = decks[currentDeck];
  const previousIndex = currentIndex;
  const nextDeckIndex = 1 - currentDeck;
  const nextDeck = decks[nextDeckIndex];
  const song = songs[index];

  const duration = Number(crossfadeRange.value);

  const canCrossfade =
    previousIndex !== -1 &&
    previousIndex !== index &&
    !previousDeck.audio.paused &&
    previousDeck.audio.currentTime > 0 &&
    duration > 0 &&
    previousDeck.audio.readyState >= 2;

  // Load the new track into the other audio deck.
  nextDeck.audio.pause();
  nextDeck.audio.removeAttribute("src");
  nextDeck.audio.load();

  nextDeck.audio.src = song.url;
  nextDeck.audio.load();

  setGain(nextDeck, 0);

  try {
    await nextDeck.audio.play();
  } catch (error) {
    showToast(
      "Playback failed. Try another file or press Play again."
    );
    return;
  }

  // A newer selection may have been made while play() was pending.
  if (nextDeck.audio.src !== new URL(song.url, location.href).href) {
    nextDeck.audio.pause();
    return;
  }

  currentDeck = nextDeckIndex;
  currentIndex = index;

  updateTrackInfo();
  renderPlaylist();
  playButton.textContent = "Ⅱ";
  playButton.setAttribute("aria-label", "Pause");

  if (canCrossfade && previousDeck.audio.src) {
    const token = fadeToken;
    setGain(nextDeck, 1, duration);
    setGain(previousDeck, 0, duration);

    fadeTimer = setTimeout(() => {
      if (token !== fadeToken) return;

      previousDeck.audio.pause();
      previousDeck.audio.currentTime = 0;
      previousDeck.audio.removeAttribute("src");
      previousDeck.audio.load();

      setGain(previousDeck, 0);
      fadeTimer = null;
    }, duration * 1000 + 100);
  } else {
    previousDeck.audio.pause();
    previousDeck.audio.currentTime = 0;
    setGain(previousDeck, 0);
    setGain(nextDeck, 1);
  }
}

function updateTrackInfo() {
  const song = songs[currentIndex];
  if (!song) return;

  $("trackTitle").textContent = song.title;
  $("trackArtist").textContent = "Playing from your device";
  $("currentTime").textContent = "0:00";
  $("duration").textContent = formatTime(song.duration);
  seekBar.value = 0;
}

function togglePlayback() {
  if (currentIndex === -1) {
    if (songs.length) {
      playSong(0);
    } else {
      fileInput.click();
    }
    return;
  }

  createAudioEngine();
  resumeAudioContext();

  const activeAudio = decks[currentDeck].audio;

  if (activeAudio.paused) {
    activeAudio.play().then(() => {
      playButton.textContent = "Ⅱ";
      playButton.setAttribute("aria-label", "Pause");
    }).catch(() => {
      showToast("Press Play again to start this song.");
    });
  } else {
    // Pause both decks so a crossfade cannot continue in the background.
    decks.forEach((deck) => deck.audio.pause());

    cancelPreviousFade();

    setGain(decks[currentDeck], 1);
    setGain(decks[1 - currentDeck], 0);

    playButton.textContent = "▶";
    playButton.setAttribute("aria-label", "Play");
  }
}

function nextSong() {
  if (!songs.length) return;

  let nextIndex;

  if (shuffle && songs.length > 1) {
    do {
      nextIndex = Math.floor(Math.random() * songs.length);
    } while (nextIndex === currentIndex);
  } else {
    nextIndex = (currentIndex + 1) % songs.length;
  }

  playSong(nextIndex);
}

function previousSong() {
  if (!songs.length) return;

  const activeAudio = decks[currentDeck]?.audio;

  if (activeAudio && activeAudio.currentTime > 3) {
    activeAudio.currentTime = 0;
    return;
  }

  const index = currentIndex <= 0
    ? songs.length - 1
    : currentIndex - 1;

  playSong(index);
}

function clearLibrary() {
  cancelPreviousFade();

  decks.forEach((deck) => {
    deck.audio.pause();
    deck.audio.removeAttribute("src");
    deck.audio.load();
    if (audioContext) setGain(deck, 0);
  });

  songs.forEach((song) => URL.revokeObjectURL(song.url));
  songs = [];
  currentIndex = -1;
  currentDeck = 0;

  $("trackTitle").textContent = "Choose your first song";
  $("trackArtist").textContent = "Your local music library";
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
  seekBar.value = 0;

  playButton.textContent = "▶";
  playButton.setAttribute("aria-label", "Play");

  renderPlaylist();
  showToast("Your music library has been cleared.");
}

function startVisualizer() {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
  }

  const bars = 72;
  let lastDraw = 0;

  function draw(timestamp) {
    animationId = requestAnimationFrame(draw);

    if (reducedMotion && timestamp - lastDraw < 100) return;
    lastDraw = timestamp;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    let bass = 0;
    let treble = 0;
    let total = 0;

    const activeDeck = decks[currentDeck];

    // Include both decks while crossfading.
    for (let d = 0; d < decks.length; d++) {
      const deck = decks[d];
      deck.analyser.getByteFrequencyData(deck.data);

      const weight = deck.gain.gain.value;

      if (d === currentDeck || weight > 0.02) {
        const length = deck.data.length;

        for (let i = 0; i < Math.min(10, length); i++) {
          bass += deck.data[i] * weight;
        }

        for (let i = Math.floor(length * 0.55); i < length; i++) {
          treble += deck.data[i] * weight;
        }

        total += weight;
      }
    }

    bass = total ? bass / (Math.min(10, activeDeck.data.length) * total * 255) : 0;
    treble = total ? treble / (activeDeck.data.length * 0.45 * total * 255) : 0;

    const intensity = Number(visualizerRange.value) / 100;
    const hue = (270 + treble * 180 + bass * 80) % 360;

    document.documentElement.style.setProperty(
      "--rgb",
      String(intensity)
    );

    document.documentElement.style.setProperty(
      "--purple",
      `hsl(${hue}, 90%, 65%)`
    );

    document.documentElement.style.setProperty(
      "--cyan",
      `hsl(${(hue + 90) % 360}, 95%, 65%)`
    );

    document.documentElement.style.setProperty(
      "--pink",
      `hsl(${(hue + 180) % 360}, 90%, 65%)`
    );

    const orbScale = 1 + bass * 0.2 * intensity;
    $("orb").style.transform = `scale(${orbScale})`;

    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const baseRadius = Math.min(rect.width, rect.height) * 0.29;
    const maxBar = Math.min(rect.width, rect.height) * 0.22;

    for (let i = 0; i < bars; i++) {
      const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;

      let value = 0;

      for (const deck of decks) {
        const weight = deck.gain.gain.value;
        if (weight < 0.005) continue;

        const bin = Math.min(
          deck.data.length - 1,
          Math.floor(Math.pow(i / bars, 1.7) * deck.data.length)
        );

        value += (deck.data[bin] / 255) * weight;
      }

      value = Math.min(1, value);

      const inner = baseRadius;
      const outer = inner + value * maxBar * intensity;

      const x1 = cx + Math.cos(angle) * inner;
      const y1 = cy + Math.sin(angle) * inner;
      const x2 = cx + Math.cos(angle) * outer;
      const y2 = cy + Math.sin(angle) * outer;

      const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
      gradient.addColorStop(0, `hsla(${hue}, 95%, 65%, 0.25)`);
      gradient.addColorStop(1, `hsla(${(hue + i * 2) % 360}, 100%, 70%, 0.95)`);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = Math.max(1.5, rect.width / 330);
      ctx.lineCap = "round";
      ctx.stroke();
    }
  }

  animationId = requestAnimationFrame(draw);
}

fileInput.addEventListener("change", (event) => {
  addFiles(event.target.files);
  event.target.value = "";
});

$("pickButton").addEventListener("click", () => fileInput.click());
$("emptyPickButton").addEventListener("click", () => fileInput.click());

playButton.addEventListener("click", togglePlayback);
$("nextButton").addEventListener("click", nextSong);
$("previousButton").addEventListener("click", previousSong);

$("shuffleButton").addEventListener("click", () => {
  shuffle = !shuffle;
  $("shuffleButton").classList.toggle("active", shuffle);
  showToast(shuffle ? "Shuffle enabled." : "Shuffle disabled.");
});

$("repeatButton").addEventListener("click", () => {
  repeat = !repeat;
  $("repeatButton").classList.toggle("active", repeat);
  showToast(repeat ? "Repeat enabled." : "Repeat disabled.");
});

$("clearButton").addEventListener("click", clearLibrary);

volumeBar.addEventListener("input", () => {
  const volume = Number(volumeBar.value) / 100;

  $("volumeLabel").textContent = `${volumeBar.value}%`;

  if (decks.length) {
    decks.forEach((deck) => {
      deck.audio.volume = volume;
    });
  }
});

crossfadeRange.addEventListener("input", () => {
  $("crossfadeLabel").textContent =
    `${Number(crossfadeRange.value).toFixed(1)} sec`;
});

visualizerRange.addEventListener("input", () => {
  $("visualizerLabel").textContent =
    `${visualizerRange.value}%`;
});

seekBar.addEventListener("pointerdown", () => {
  isSeeking = true;
});

seekBar.addEventListener("pointerup", () => {
  isSeeking = false;
});

seekBar.addEventListener("input", () => {
  if (!decks.length || currentIndex === -1) return;

  const audio = decks[currentDeck].audio;

  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    audio.currentTime =
      (Number(seekBar.value) / 1000) * audio.duration;
  }
});

function updateProgress() {
  requestAnimationFrame(updateProgress);

  if (!decks.length || currentIndex === -1) return;

  const audio = decks[currentDeck].audio;

  if (Number.isFinite(audio.duration)) {
    $("currentTime").textContent = formatTime(audio.currentTime);
    $("duration").textContent = formatTime(audio.duration);

    if (!isSeeking && audio.duration > 0) {
      seekBar.value = Math.round(
        (audio.currentTime / audio.duration) * 1000
      );
    }
  }

  if (audio.paused && playButton.textContent !== "▶") {
    playButton.textContent = "▶";
    playButton.setAttribute("aria-label", "Play");
  }
}

renderPlaylist();
updateProgress();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .catch((error) => {
        console.error("Pulse offline setup failed:", error);
      });
  });
}

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;

  const song = songs[currentIndex];

  if (!song) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
    return;
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: "Pulse Music Player",
    album: "Local Music",
    artwork: [
      {
        src: "./icon-192.png",
        sizes: "192x192",
        type: "image/png"
      },
      {
        src: "./icon-512.png",
        sizes: "512x512",
        type: "image/png"
      }
    ]
  });

  navigator.mediaSession.playbackState =
    decks[currentDeck].audio.paused ? "paused" : "playing";
}

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => {
    togglePlayback();
  });

  navigator.mediaSession.setActionHandler("pause", () => {
    togglePlayback();
  });

  navigator.mediaSession.setActionHandler("nexttrack", () => {
    nextSong();
  });

  navigator.mediaSession.setActionHandler("previoustrack", () => {
    previousSong();
  });

  navigator.mediaSession.setActionHandler("seekto", (details) => {
    const audio = decks[currentDeck]?.audio;

    if (
      audio &&
      Number.isFinite(audio.duration) &&
      Number.isFinite(details.seekTime)
    ) {
      audio.currentTime = Math.max(
        0,
        Math.min(audio.duration, details.seekTime)
      );
    }
  });
}

