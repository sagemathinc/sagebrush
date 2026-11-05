"""The small SSL context interface used by replay-only network clients.

Sagebrush does not open TLS sockets: :mod:`urllib.request` reads verified
folder snapshots instead.  Some Python programs still configure the stdlib
HTTPS context before they make a replayed request, so these context objects
carry that configuration without pretending to provide a TLS transport.
"""

CERT_NONE = 0
CERT_OPTIONAL = 1
CERT_REQUIRED = 2

PROTOCOL_TLS = 2
PROTOCOL_TLS_CLIENT = 16
PROTOCOL_TLS_SERVER = 17


class _Purpose:
    pass


class Purpose:
    SERVER_AUTH = _Purpose()
    CLIENT_AUTH = _Purpose()


class SSLContext:
    def __init__(self, protocol):
        self.protocol = protocol
        self.check_hostname = protocol == PROTOCOL_TLS_CLIENT
        self._verify_mode = CERT_REQUIRED if self.check_hostname else CERT_NONE

    @property
    def verify_mode(self):
        return self._verify_mode

    @verify_mode.setter
    def verify_mode(self, value):
        if value == CERT_NONE and self.check_hostname:
            raise ValueError("Cannot set verify_mode to CERT_NONE when check_hostname is enabled.")
        if value not in (CERT_NONE, CERT_OPTIONAL, CERT_REQUIRED):
            raise ValueError("invalid value for verify_mode")
        self._verify_mode = value

    def load_default_certs(self, purpose=Purpose.SERVER_AUTH):
        return None

    def load_verify_locations(self, cafile=None, capath=None, cadata=None):
        return None

    def load_cert_chain(self, certfile, keyfile=None, password=None):
        raise NotImplementedError("ssl: certificate files are not used by Sagebrush's replay-only network client")


def _context_for(purpose, protocol):
    if not isinstance(purpose, _Purpose):
        raise TypeError(purpose)
    if purpose is Purpose.SERVER_AUTH:
        return protocol if protocol is not None else PROTOCOL_TLS_CLIENT
    if purpose is Purpose.CLIENT_AUTH:
        return protocol if protocol is not None else PROTOCOL_TLS_SERVER
    raise ValueError(purpose)


def create_default_context(purpose=Purpose.SERVER_AUTH, *, cafile=None, capath=None, cadata=None):
    context = SSLContext(_context_for(purpose, None))
    if purpose is Purpose.SERVER_AUTH:
        context.verify_mode = CERT_REQUIRED
        context.check_hostname = True
    if cafile or capath or cadata:
        context.load_verify_locations(cafile, capath, cadata)
    elif context.verify_mode != CERT_NONE:
        context.load_default_certs(purpose)
    return context


def _create_unverified_context(
    protocol=None,
    *,
    cert_reqs=CERT_NONE,
    check_hostname=False,
    purpose=Purpose.SERVER_AUTH,
    certfile=None,
    keyfile=None,
    cafile=None,
    capath=None,
    cadata=None,
):
    context = SSLContext(_context_for(purpose, protocol))
    context.check_hostname = check_hostname
    if cert_reqs is not None:
        context.verify_mode = cert_reqs
    if keyfile and not certfile:
        raise ValueError("certfile must be specified")
    if certfile or keyfile:
        context.load_cert_chain(certfile, keyfile)
    if cafile or capath or cadata:
        context.load_verify_locations(cafile, capath, cadata)
    elif context.verify_mode != CERT_NONE:
        context.load_default_certs(purpose)
    return context


_create_default_https_context = create_default_context
_create_stdlib_context = _create_unverified_context
