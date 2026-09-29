import { stripVTControlCharacters } from 'node:util';

export function redactGitError(output: string, credential: string): string {
  const secrets = [
    credential,
    encodeURIComponent(credential),
    Buffer.from(credential).toString('base64'),
    Buffer.from(`x-access-token:${credential}`).toString('base64'),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let safe = stripVTControlCharacters(output).replace(
    /[\p{Cc}\p{Cf}]/gu,
    (character) => (character === '\n' || character === '\t' ? character : ''),
  );
  for (const secret of secrets) {
    safe = safe.split(secret).join('[redacted]');
  }
  return safe
    .replace(/(authorization:\s*)[^\n]*/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/]+@/gi, '$1[redacted]@');
}

export function gitErrorMessage(stderr: string, errorCode?: string): string {
  if (errorCode === 'ENOENT') {
    return 'Git is not installed in the Cerebra backend. Rebuild the backend image with Git, then try again.';
  }
  if (errorCode === 'EACCES') {
    return 'Cerebra cannot execute Git. Check executable permissions in the backend image, then try again.';
  }
  if (/SAML|SSO|single sign.on/i.test(stderr)) {
    return 'GitHub requires organization SSO authorization. Authorize your token for the organization, then try again.';
  }
  if (
    /authentication failed|could not read (Username|Password)|repository not found|returned error: (401|403|404)|access denied/i.test(
      stderr,
    )
  ) {
    return 'GitHub refused repository access. Check the repository link and that your token can read its contents (Contents: Read for a fine-grained token), then try again.';
  }
  if (
    /could not resolve|failed to connect|connection (timed out|refused|reset)|network is unreachable|unable to access/i.test(
      stderr,
    ) &&
    !/certificate|SSL|TLS/i.test(stderr)
  ) {
    return 'Cerebra could not reach GitHub. Check the Podman machine’s network, DNS and proxy settings, then try again.';
  }
  if (/certificate|SSL|TLS/i.test(stderr)) {
    return 'Git could not establish a secure connection to GitHub. Check the backend’s CA certificates and any HTTPS proxy, then try again.';
  }
  if (/no space left|disk quota exceeded/i.test(stderr)) {
    return 'The repository could not be copied because storage is full. Free space in the Podman machine or increase its disk allocation, then try again.';
  }
  if (/permission denied|read.only file system/i.test(stderr)) {
    return 'Cerebra cannot write its repository copy. Check the backend’s storage permissions and that its data volume is writable, then try again.';
  }
  if (/already exists/i.test(stderr)) {
    return 'The repository copy’s destination already exists. Check Cerebra’s logs for the conflicting path before retrying.';
  }
  const details = stderr.trim();
  return details
    ? `Git could not copy the repository. Git reported: ${details.slice(0, 2000)}${details.length > 2000 ? '…' : ''} Check Cerebra’s logs for details.`
    : 'Git stopped before it could copy the repository. Check Cerebra’s logs for its exit status, then try again.';
}
