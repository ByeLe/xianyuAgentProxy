import asyncio
import json
import os
import sys
import threading
import time

from aiohttp import ClientSession, ClientTimeout, web
from loguru import logger
import websockets

from goofish_live import XianyuLive
from message import make_text
from utils.goofish_utils import decrypt, generate_mid, get_session_cookies_str

logger.remove()
logger.add(sys.stderr, diagnose=False, level=os.getenv("LOG_LEVEL", "INFO"))


def env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def bearer_token(request):
    value = request.headers.get("authorization", "")
    prefix = "Bearer "
    if value.startswith(prefix):
        return value[len(prefix):]
    return request.headers.get("x-apiproxy-token", "")


def first_value(value):
    if isinstance(value, list):
        for item in value:
            if item not in (None, ""):
                return item
        return None
    return value


def find_chat_nodes(value):
    nodes = []
    if isinstance(value, dict):
        if "10" in value and "2" in value:
            nodes.append(value)
        for child in value.values():
            nodes.extend(find_chat_nodes(child))
    elif isinstance(value, list):
        for child in value:
            nodes.extend(find_chat_nodes(child))
    return nodes


def extract_chat_event(payload, myid):
    for node in find_chat_nodes(payload):
        extension = first_value(node.get("10"))
        if not isinstance(extension, dict):
            continue

        buyer_id = first_value(extension.get("senderUserId"))
        message_text = first_value(extension.get("reminderContent"))
        cid = first_value(node.get("2"))

        if not buyer_id or not message_text or not cid:
            continue
        if str(buyer_id) == str(myid):
            return None

        return {
            "conversation_id": str(cid).split("@")[0],
            "buyer_id": str(buyer_id),
            "buyer_name": str(first_value(extension.get("reminderTitle")) or ""),
            "message_text": str(message_text),
            "raw": payload,
        }
    return None


class XianyuAgentBridge(XianyuLive):
    def __init__(self, cookies_str):
        super().__init__(cookies_str)
        self.active_ws = None
        self.http_runner = None
        self.client = None
        self.proxy_message_url = os.getenv("PROXY_MESSAGE_URL", "http://agent-proxy:7892/xianyu/message")
        self.proxy_inbound_token = os.getenv("PROXY_INBOUND_TOKEN", "")
        self.bridge_send_token = os.getenv("BRIDGE_SEND_TOKEN", "")
        self.request_timeout = env_int("REQUEST_TIMEOUT_SECONDS", 20)
        self.http_host = os.getenv("BRIDGE_HOST", "0.0.0.0")
        self.http_port = env_int("BRIDGE_PORT", 7893)

    async def start(self):
        self.client = ClientSession(timeout=ClientTimeout(total=self.request_timeout))
        await self.start_http_server()
        threading.Thread(target=self.user_alive, daemon=True).start()
        await self.websocket_loop()

    async def start_http_server(self):
        app = web.Application()
        app.add_routes([
            web.get("/health", self.handle_health),
            web.post("/xianyu/send", self.handle_send),
        ])
        self.http_runner = web.AppRunner(app)
        await self.http_runner.setup()
        site = web.TCPSite(self.http_runner, self.http_host, self.http_port)
        await site.start()
        logger.info(f"xianyu bridge http listening on {self.http_host}:{self.http_port}")

    async def handle_health(self, request):
        return web.json_response({
            "ok": True,
            "service": "xianyu-bridge",
            "ws_connected": self.active_ws is not None,
            "myid": self.myid,
        })

    async def handle_send(self, request):
        if self.bridge_send_token and bearer_token(request) != self.bridge_send_token:
            return web.json_response({"ok": False, "error": "鉴权失败"}, status=401)

        if self.active_ws is None:
            return web.json_response({"ok": False, "error": "闲鱼 WebSocket 未连接"}, status=503)

        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "请求体必须是 JSON"}, status=400)

        cid = body.get("conversation_id") or body.get("cid")
        buyer_id = body.get("buyer_id") or body.get("toid") or body.get("receiver_id")
        text = body.get("text") or body.get("reply_text")

        if not cid or not buyer_id or not text:
            return web.json_response({
                "ok": False,
                "error": "缺少 conversation_id、buyer_id 或 text"
            }, status=400)

        await self.send_msg(self.active_ws, str(cid), str(buyer_id), make_text(str(text)))
        logger.info(f"sent xianyu reply cid={cid} buyer_id={buyer_id}")

        return web.json_response({
            "ok": True,
            "correlation_id": body.get("correlation_id", ""),
            "conversation_id": str(cid),
            "buyer_id": str(buyer_id),
        })

    async def websocket_loop(self):
        headers = {
            "Cookie": get_session_cookies_str(self.xianyu.session),
            "Host": "wss-goofish.dingtalk.com",
            "Connection": "Upgrade",
            "Pragma": "no-cache",
            "Cache-Control": "no-cache",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
            "Origin": "https://www.goofish.com",
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }

        while True:
            heartbeat_task = None
            try:
                async with websockets.connect(self.base_url, extra_headers=headers) as websocket:
                    self.active_ws = websocket
                    await self.init(websocket)
                    heartbeat_task = asyncio.create_task(self.heart_beat(websocket))
                    logger.info("xianyu websocket connected")

                    async for raw_message in websocket:
                        message = json.loads(raw_message)
                        await self.ack_message(websocket, message)
                        await self.handle_message(message, websocket)
            except Exception as error:
                logger.exception(f"xianyu websocket disconnected: {error}")
                self.active_ws = None
                await asyncio.sleep(5)
            finally:
                self.active_ws = None
                if heartbeat_task:
                    heartbeat_task.cancel()

    async def ack_message(self, websocket, message):
        headers = message.get("headers", {})
        ack = {
            "code": 200,
            "headers": {
                "mid": headers.get("mid", generate_mid()),
                "sid": headers.get("sid", ""),
            }
        }
        for key in ("app-key", "ua", "dt"):
            if key in headers:
                ack["headers"][key] = headers[key]
        await websocket.send(json.dumps(ack))

    async def handle_message(self, message, websocket):
        try:
            data_items = message["body"]["syncPushPackage"]["data"]
        except Exception:
            return

        for item in data_items:
            data = item.get("data") if isinstance(item, dict) else None
            if data:
                await self.handle_sync_data(data)

    async def handle_sync_data(self, data):
        try:
            payload = json.loads(data)
            source = "plain"
        except Exception:
            try:
                decrypted = decrypt(data)
                payload = json.loads(decrypted)
                source = "encrypted"
            except Exception as error:
                logger.exception(f"failed to decrypt xianyu sync data: {error}")
                return

        try:
            event = extract_chat_event(payload, self.myid)
            if not event:
                logger.debug(
                    "xianyu sync data ignored source={} payload_type={}",
                    source,
                    type(payload).__name__,
                )
                return

            logger.info(
                "received xianyu message cid={} buyer={}: {}",
                event["conversation_id"],
                event["buyer_name"],
                event["message_text"],
            )
            asyncio.create_task(self.forward_to_proxy(event))
        except Exception as error:
            logger.exception(f"failed to parse xianyu message: {error}")

    async def forward_to_proxy(self, event):
        if not self.proxy_message_url:
            logger.warning("PROXY_MESSAGE_URL is empty, skip forwarding")
            return

        headers = {}
        if self.proxy_inbound_token:
            headers["Authorization"] = f"Bearer {self.proxy_inbound_token}"

        try:
            async with self.client.post(self.proxy_message_url, json=event, headers=headers) as response:
                text = await response.text()
                if response.status >= 400:
                    logger.error(f"proxy rejected message status={response.status} body={text}")
                    return
                logger.info(f"forwarded to proxy status={response.status} body={text}")
        except Exception as error:
            logger.exception(f"forward to proxy failed: {error}")


async def main():
    cookies_str = os.getenv("XIANYU_COOKIES") or os.getenv("COOKIES_STR") or ""
    if not cookies_str:
        raise SystemExit("请配置 XIANYU_COOKIES 环境变量")

    bridge = XianyuAgentBridge(cookies_str)
    await bridge.start()


if __name__ == "__main__":
    asyncio.run(main())
