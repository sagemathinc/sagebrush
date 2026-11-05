import ssl


def show(label, context):
    print(label, int(context.protocol), int(context.verify_mode), context.check_hostname)


print("default alias", ssl._create_default_https_context is ssl.create_default_context)
print("stdlib alias", ssl._create_stdlib_context is ssl._create_unverified_context)
show("default", ssl.create_default_context())
show("unverified", ssl._create_unverified_context())
show("required", ssl._create_unverified_context(cert_reqs=ssl.CERT_REQUIRED))
show("required host", ssl._create_unverified_context(cert_reqs=ssl.CERT_REQUIRED, check_hostname=True))
show("server", ssl._create_unverified_context(protocol=ssl.PROTOCOL_TLS_SERVER))
mutation = ssl.SSLContext(ssl.PROTOCOL_TLS)
show("mutation before", mutation)
mutation.check_hostname = True
show("mutation after", mutation)
try:
    mutation.verify_mode = ssl.CERT_NONE
except ValueError as error:
    print("mutation refused", type(error).__name__, str(error))
ssl._create_default_https_context = ssl._create_unverified_context
print("override", ssl._create_default_https_context is ssl._create_unverified_context)
