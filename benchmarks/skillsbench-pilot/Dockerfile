ARG DSH_IMAGE=dsh-adaptive-loop/skillsbench-base:cfc34cdf3dc774ad2f2f388220f168b41832601b6c397418e7260db111c1823e
FROM ${DSH_IMAGE}
ARG DSH_IMAGE
USER root
RUN test "$DSH_IMAGE" = "dsh-adaptive-loop/skillsbench-base:cfc34cdf3dc774ad2f2f388220f168b41832601b6c397418e7260db111c1823e"
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
    && python3 -m venv /opt/pilot-venv \
    && /opt/pilot-venv/bin/pip install --no-cache-dir pytest==8.4.1 numpy==2.2.6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /root
RUN mkdir -p /opt/pilot-js /root/data /root/output \
    && npm install --prefix /opt/pilot-js --ignore-scripts --no-audit --no-fund --save-exact three@0.175.0 \
    && ln -s /opt/pilot-js/node_modules /root/node_modules \
    && npm init -y && npm pkg set type=module
ENV PATH="/opt/pilot-venv/bin:${PATH}" \
    PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_INDEX=1 \
    npm_config_offline=true
WORKDIR /root
# No COPY/ADD: task inputs, skills, oracle and ground truth are runtime projections.
# Main must pin the resulting image ID and enforce --network=none for qualification.
