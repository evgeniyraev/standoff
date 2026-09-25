"""Minimal PC app for testing the Flipper Quiz Buzzer (pc-app-ble-integration.md).

Scans by the NUS service UUID (§1), connects, subscribes to TX indications
(§2.5), sends PING every 2 s while the device is waiting (§7), and sends START
when you press Enter. Prints every BTN / STATE event, dropping duplicate BTN
seqs (§7). Reconnects automatically if the link drops (§6).

    pip install bleak
    python pc_test_client.py
"""
import asyncio
import sys

from bleak import BleakClient, BleakScanner

NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # we write commands here
NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # device indicates events here
PING_PERIOD_S = 2.0


class Session:
    def __init__(self):
        self.waiting = True  # device in waiting-for-game-start
        self.last_seq = None

    def on_tx(self, _char, data: bytearray):
        msg = data.decode(errors="replace").strip()
        if msg.startswith("BTN:"):
            _, pid, seq = msg.split(":")
            if seq == self.last_seq:
                print(f"  (duplicate {msg} ignored)")
                return
            self.last_seq = seq
            print(f"*** BUZZ: player {pid} (seq {seq})")
        elif msg.startswith("STATE:"):
            self.waiting = msg == "STATE:WAITING"
            print(f"state -> {msg[6:]}")
        else:
            print(f"? {msg}")


async def find_device():
    print("Scanning for the NUS service...")
    while True:
        dev = await BleakScanner.find_device_by_filter(
            lambda d, adv: NUS_SERVICE in [u.lower() for u in adv.service_uuids],
            timeout=10.0,
        )
        if dev:
            print(f"Found {dev.name!r} at {dev.address}")
            return dev
        print("  not found yet (is the Flipper app open and showing 'Advertising'?)")


async def stdin_lines(queue: asyncio.Queue):
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        await queue.put(line.strip().lower())


async def run():
    session = Session()
    commands: asyncio.Queue = asyncio.Queue()
    asyncio.create_task(stdin_lines(commands))
    dev = await find_device()

    while True:  # §6: keep reconnecting
        disconnected = asyncio.Event()
        try:
            async with BleakClient(dev, disconnected_callback=lambda _c: disconnected.set()) as client:
                print("Connected. Subscribing to TX (pairing may happen now)...")
                await client.start_notify(NUS_TX, session.on_tx)  # re-subscribe every time (§4)
                print("Ready. Press Enter to send START, 'q' + Enter to quit.")
                next_ping = 0.0
                while not disconnected.is_set():
                    try:
                        cmd = await asyncio.wait_for(commands.get(), timeout=0.2)
                    except asyncio.TimeoutError:
                        cmd = None
                    if cmd == "q":
                        return
                    if cmd is not None:
                        await client.write_gatt_char(NUS_RX, b"START", response=True)  # §2.6
                        session.waiting = False
                        print("-> START")
                    now = asyncio.get_running_loop().time()
                    if session.waiting and now >= next_ping:
                        await client.write_gatt_char(NUS_RX, b"PING", response=True)
                        next_ping = now + PING_PERIOD_S
        except Exception as e:  # connection or GATT failure
            print(f"Link error: {e}")
        print("Disconnected, reconnecting...")
        await asyncio.sleep(1.0)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
