# Rust Booter

A simple web app that wakes up your gaming PC and launches Rust to connect to your server.

## What it does

1. Sends a magic packet to wake up your gaming PC
2. Waits for it to boot up (checks if it's ready)
3. Launches Rust and connects to your server

## Setup

```bash
npm install
npm start
```

Then go to `http://localhost:8534` in your browser.

## Configuration

You'll need to set up:
- Your gaming PC's IP address and MAC address
- The Rust server you want to connect to

The web interface makes this pretty easy - just fill in the boxes and hit save.

## Requirements

Your gaming PC needs:
- Wake-on-LAN enabled (in BIOS and Windows network settings)
- A Rust Game Controller API running on port 5000

The API needs two endpoints:
- `GET /health` - returns `{"status": "healthy"}` when ready
- `POST /game/launch` - launches the game with server details