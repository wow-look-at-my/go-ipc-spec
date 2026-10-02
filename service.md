# Service: typed request and reply

A service is a server process that answers calls from any number of client processes. The server and each client speak over the queues and channels of this protocol, and nothing else. This file states the names, the handshake, the framing and the error reply, so that every language encodes the same bytes. `wire.json` holds the constants under `service`.

A consumer of a service names it, sends a request, and gets the reply or an error. It does not see a queue name, an instance id, a procID, or how the peer's exit is detected.

## Names

A service named `S` uses these endpoints:

| endpoint | kind | created by |
| --- | --- | --- |
| `S.svc` | queue | the server |
| `S.c.{id}` | channel | a client, one per connection |

`{id}` is 8 bytes from a cryptographic random source, as 16 lowercase hexadecimal digits, so two clients never pick one name. The service name follows the rules in "Names" of `README.md`.

The server creates `S.svc` and holds its name for its whole life. A second server for the same name gets in-use. A client creates its channel and holds that name for the life of the connection.

## Record types

The service layer reserves every record type from `0xFFFFFFF0` up to the padding type. A call with a type in that range reports reserved-type before anything is sent.

| type | name | direction | payload |
| --- | --- | --- | --- |
| `0xFFFFFFF0` | knock | client to `S.svc` | the 16 hexadecimal digits of the client's `{id}`, in ASCII |
| `0xFFFFFFF1` | hello | server to client, on the channel | `u64` ordinal, little-endian |
| `0xFFFFFFF2` | error | server to client, on the channel | `u64` sequence, then the message in UTF-8 |

Any other type is a request or a reply, and belongs to the consumer.

## Framing

A request is one record on the client's channel, from the client to the server. Its type is the consumer's request type. Its payload is a `u64` sequence number, little-endian, then the consumer's payload.

A reply is one record on the same channel, from the server to the client. Its type is the consumer's reply type, or the error type. Its payload is the `u64` sequence number of the request it answers, then the consumer's reply payload, or the error message.

The sequence number starts at 1 on each connection and goes up by 1 with each call. A client has one call in flight at a time. A reply whose sequence number is below the one the client waits for answers a call the client gave up on, and the client discards it. A reply whose sequence number is above it is a protocol error.

The largest consumer payload is the channel's largest payload less 8.

## Connect

A client connects to the service `S` like this:

1. Make an `{id}`. Create the channel `S.c.{id}`.
2. Open the queue `S.svc`. When the open fails for any reason, go to step 4. The server is not up, or it has gone, and the next server finds the channel on its own.
3. Send a knock record with a blocking send. Close the queue. A send that fails is not an error, for the same reason.
4. Receive on the channel, blocking. The first record is the hello record, and its payload is this client's ordinal. Any other record is a protocol error.

Step 4 is where a client that arrived before the server waits. It parks on the channel's not-empty event, as any channel receive does. The server's open of the channel signals that event, and the hello record follows. No implementation polls for the server.

A client that gives up in step 4 closes and unlinks its channel.

## Serve

A server for the service `S` does this:

1. Create the queue `S.svc`. In-use means another server lives.
2. Scan the runtime directory once, for every name file of the form `go-ipc-S.c.{id}.o2c.name` whose `{id}` is 16 hexadecimal digits. For each, adopt `{id}`.
3. Receive on `S.svc` until the server closes. For each knock record whose payload is 16 hexadecimal digits, adopt that `{id}`. Ignore every other record.

**Adopt.** Open the channel `S.c.{id}`. When the open fails, do nothing: in-use means the channel was adopted already, peer-gone means the client exited, not-found and not-ready mean the client has not finished creating it and knocks when it has. Otherwise give the client the next ordinal, starting at 0, send the hello record, and serve the channel.

The scan in step 2 comes after the queue is published in step 1. A client whose channel the scan does not find therefore opens `S.svc` after it exists, and its knock reaches step 3. A client whose channel the scan finds but cannot open yet does the same.

**Serve a channel.** Receive on the channel. For each request, hand its type and its consumer payload to the handler. Send one reply: the handler's reply type and payload, or the error record with the handler's message. A request shorter than 8 bytes gets an error reply with sequence 0. A receive that reports peer-gone means the client exited or closed: report it to the handler, close the channel, and unlink it.

The handler of one client runs independently of the handler of another. A handler that blocks holds up only its own client. The ordinal is the server's count of adopted clients, and tells clients apart.

**Close.** Close the queue `S.svc` and unlink it. Close every channel. A client parked in a call then reports peer-gone, as a channel receive does when its peer closes.

## Errors

| condition | reported as |
| --- | --- |
| The handler returned an error | A call error that carries the message. Go: `*CallError`. Python: `goipc.service.CallError`. C: `GOIPC_ECALL`, with the message in the reply buffer. C++: `goipc::call_error`. |
| The server exited or closed | peer-gone, from the call that finds it |
| The call's type is in the reserved range | reserved-type |
| A reply arrives with a sequence number above the expected one, or a record that is not a reply arrives | corrupt |
| The hello record does not arrive within the connect timeout | the language's timeout error |

A server that cannot create its queue reports the queue's error. A client that cannot create its channel reports the channel's error.
