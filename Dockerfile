# Specify the Node.js version to use
ARG NODE_VERSION=22

# Specify the Debian version to use. Pinned to a maintained release
# ("bookworm", Debian 12) rather than EOL-bound "bullseye" (Debian 11):
# as bullseye ages out of the stable security-mirror rotation, point
# releases get superseded and their .debs disappear from
# deb.debian.org/debian-security, producing intermittent 404s on
# unrelated transitive deps (e.g. libcap2) during `apt-get install`.
ARG DEBIAN_VERSION=bookworm

# Use Node.js Docker image as the base image, with specific Node and Debian versions
FROM node:${NODE_VERSION}-${DEBIAN_VERSION} AS build

# Set the container's default shell to Bash and enable some options
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# Install Chromium and native build tooling needed by some yarn deps.
# apt-get update + install run in the same layer so the package index
# used to resolve versions is never stale relative to what gets installed.
RUN apt-get update -qq && \
    apt-get -qqy --no-install-recommends install chromium traceroute python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Run the Chromium browser's version command and redirect its output to the /etc/chromium-version file
RUN /usr/bin/chromium --no-sandbox --version > /etc/chromium-version

# Set the working directory to /app
WORKDIR /app

# Copy package.json and yarn.lock to the working directory
COPY package.json yarn.lock ./

# Run yarn install to install dependencies and clear yarn cache
RUN yarn install --frozen-lockfile --network-timeout 100000 && \
    rm -rf /app/node_modules/.cache

# Copy all files to working directory
COPY . .

# Run yarn build to build the application
RUN yarn build --production

# Final stage
FROM node:${NODE_VERSION}-${DEBIAN_VERSION}  AS final

WORKDIR /app

COPY package.json yarn.lock ./
COPY --from=build /app .

RUN apt-get update -qq && \
    apt-get -qqy --no-install-recommends install chromium traceroute && \
    chmod 755 /usr/bin/chromium && \
    rm -rf /var/lib/apt/lists/* /app/node_modules/.cache

# Exposed container port, the default is 3000, which can be modified through the environment variable PORT
EXPOSE ${PORT:-3000}

# Point Chromium-using libs at the system binary, skip puppeteer's bundled download
ENV CHROME_PATH='/usr/bin/chromium' \
    PUPPETEER_EXECUTABLE_PATH='/usr/bin/chromium' \
    PUPPETEER_SKIP_DOWNLOAD='true'

LABEL org.opencontainers.image.title="Web-Check" \
      org.opencontainers.image.description="All-in-one OSINT tool for analysing any website" \
      org.opencontainers.image.url="https://web-check.xyz" \
      org.opencontainers.image.source="https://github.com/lissy93/web-check" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Alicia Sykes"

# Define the command executed when the container starts and start the server.js of the Node.js application
CMD ["yarn", "start"]
