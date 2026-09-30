# The agent image with its runner replaying a script instead of calling a model: what the
# real-Podman end-to-end test starts (architecture §13). Build images/agent.Containerfile as
# cerebro-agent first.
FROM cerebro-agent
CMD ["node", "/app/packages/runner/dist/stub-main.js"]
