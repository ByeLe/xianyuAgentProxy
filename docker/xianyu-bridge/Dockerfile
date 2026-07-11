FROM python:3.12-slim

ARG XIANYU_APIS_REPO=https://github.com/cv-cat/XianYuApis.git
ARG XIANYU_APIS_REF=master

RUN apt-get update \
    && apt-get install -y --no-install-recommends git nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth=1 --branch "${XIANYU_APIS_REF}" "${XIANYU_APIS_REPO}" /app

WORKDIR /app

COPY xianyu_agent_bridge.py /app/xianyu_agent_bridge.py

RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir aiohttp websockets==13.1 PyExecJS blackboxprotobuf pydantic typing_extensions qrcode

EXPOSE 7893

CMD ["python", "xianyu_agent_bridge.py"]
