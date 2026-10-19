# The Node host as an image. The app links Hypha's SDK from a checkout next to it, so
# the bundle is built first (on the host, or in CI) and the image holds only it:
#
#   pnpm build:node && docker build -t hypha-app-meilisearch .
#   docker run -p 8787:8787 -v meili-app:/data \
#     -e APP_URL=https://meilisearch-app.example.com \
#     -e APP_ENCRYPTION_KEY=$(openssl rand -hex 32) hypha-app-meilisearch
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/meilisearch-app.sqlite
COPY dist/ ./dist/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/node.mjs"]
