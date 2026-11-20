/*
 * stim-fsevents <latency-seconds>
 *
 * Reports which watched roots changed, replaying FSEvents history from a
 * stored event id and then streaming live changes.
 *
 * Stdin, one JSON object per line of at most 4 MiB. Each line replaces every
 * watch:
 *   {"generation": N, "watch": [{"dev": N, "uuid": "..." | null, "since": N | null,
 *                                "sinceAt": N | null, "roots": ["/abs/path", ...]}]}
 * `sinceAt` is the Unix time in seconds at which the caller stored `since`.
 * A device appears at most once. Roots are canonical absolute paths on device
 * `dev`, at most 1024 per device: FSEventStreamStart fails on one stream with
 * a few thousand paths. Stdin EOF ends the program with status 0.
 *
 * Stdout, one JSON object per line, each starting with the `generation` of
 * the watch line it answers; root indexes refer to that line:
 *   {"generation": N, "dev": N, "purged": "<reason>", "uuid": "..." | null, "eventId": N}
 *     History from `since` cannot be trusted: treat every root of `dev` as
 *     changed and store `uuid` and `eventId`. Reasons: no-since, no-uuid,
 *     uuid-changed, id-ahead, too-old (`sinceAt` missing, in the future or
 *     more than 2 hours ago, since FSEvents drops old history without saying
 *     so), dropped, ids-wrapped, and fd-limit (the watch needs more file
 *     descriptors than the helper may open, the smaller of its soft limit and
 *     kern.maxfilesperproc, or that sysctl cannot be read; no stream runs for
 *     that watch line and nothing follows the purge).
 *   {"generation": N, "dev": N, "dirty": [rootIndex, ...], "eventId": N}
 *     Roots that changed up to `eventId`, including a root that was renamed,
 *     moved or deleted with one of its parents.
 *     History replay prints one such line, right before historyDone, and at
 *     most one purged line; live changes print one line per batch.
 *   {"generation": N, "dev": N, "historyDone": true, "uuid": "..." | null, "eventId": N}
 *     Every change before `eventId` has been reported.
 * `eventId` never decreases for a device within one watch.
 *
 * Known limits: a replay can miss a change, so the caller must still expire
 * its marks on a schedule. A root's parent renamed away and back while no
 * helper ran, with an edit made under the temporary name, leaves no event
 * under the root's path. A volume restored to a snapshot with the same
 * FSEvents uuid within 2 hours of `sinceAt` passes every check while other
 * volumes keep the host's event id above `since`.
 *
 * Exit status: 64 usage, 65 malformed input, 70 stream failure, 74 I/O error.
 */
#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <inttypes.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/syslimits.h>
#include <time.h>
#include <unistd.h>

typedef enum { J_NULL, J_BOOL, J_NUMBER, J_STRING, J_ARRAY, J_OBJECT } json_kind;

typedef struct json {
  json_kind kind;
  char *text;
  char **keys;
  struct json *items;
  size_t count;
} json;

typedef struct {
  const char *at;
  const char *end;
} cursor;

static bool parse_value(cursor *c, json *out, int depth);

static void skip_space(cursor *c) {
  while (c->at < c->end && (*c->at == ' ' || *c->at == '\t' || *c->at == '\r' || *c->at == '\n')) c->at++;
}

static void json_free(json *v) {
  free(v->text);
  for (size_t i = 0; i < v->count; i++) {
    if (v->keys) free(v->keys[i]);
    json_free(&v->items[i]);
  }
  free(v->keys);
  free(v->items);
}

static bool hex4(cursor *c, unsigned *out) {
  if (c->end - c->at < 4) return false;
  unsigned value = 0;
  for (int i = 0; i < 4; i++) {
    char h = *c->at++;
    value <<= 4;
    if (h >= '0' && h <= '9') value |= (unsigned)(h - '0');
    else if (h >= 'a' && h <= 'f') value |= (unsigned)(h - 'a' + 10);
    else if (h >= 'A' && h <= 'F') value |= (unsigned)(h - 'A' + 10);
    else return false;
  }
  *out = value;
  return true;
}

static bool parse_string(cursor *c, char **out) {
  if (c->at >= c->end || *c->at != '"') return false;
  c->at++;
  const char *close = c->at;
  while (close < c->end && *close != '"') close += *close == '\\' && close + 1 < c->end ? 2 : 1;
  if (close >= c->end) return false;
  char *text = malloc((size_t)(close - c->at) + 1);
  if (!text) return false;
  size_t n = 0;
  while (c->at < c->end && *c->at != '"') {
    unsigned char ch = (unsigned char)*c->at++;
    if (ch < 0x20) goto fail;
    if (ch != '\\') {
      text[n++] = (char)ch;
      continue;
    }
    if (c->at >= c->end) goto fail;
    char e = *c->at++;
    unsigned cp;
    switch (e) {
    case '"': case '\\': case '/': text[n++] = e; continue;
    case 'b': text[n++] = '\b'; continue;
    case 'f': text[n++] = '\f'; continue;
    case 'n': text[n++] = '\n'; continue;
    case 'r': text[n++] = '\r'; continue;
    case 't': text[n++] = '\t'; continue;
    case 'u': break;
    default: goto fail;
    }
    if (!hex4(c, &cp)) goto fail;
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      unsigned low;
      if (c->end - c->at < 2 || c->at[0] != '\\' || c->at[1] != 'u') goto fail;
      c->at += 2;
      if (!hex4(c, &low) || low < 0xDC00 || low > 0xDFFF) goto fail;
      cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      goto fail;
    }
    if (cp == 0) goto fail;
    if (cp < 0x80) {
      text[n++] = (char)cp;
    } else if (cp < 0x800) {
      text[n++] = (char)(0xC0 | (cp >> 6));
      text[n++] = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      text[n++] = (char)(0xE0 | (cp >> 12));
      text[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
      text[n++] = (char)(0x80 | (cp & 0x3F));
    } else {
      text[n++] = (char)(0xF0 | (cp >> 18));
      text[n++] = (char)(0x80 | ((cp >> 12) & 0x3F));
      text[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
      text[n++] = (char)(0x80 | (cp & 0x3F));
    }
  }
  if (c->at >= c->end) goto fail;
  c->at++;
  text[n] = 0;
  *out = text;
  return true;
fail:
  free(text);
  return false;
}

static bool append(json *list, json *item, char *key) {
  json *items = realloc(list->items, (list->count + 1) * sizeof *items);
  if (!items) return false;
  list->items = items;
  if (list->kind == J_OBJECT) {
    char **keys = realloc(list->keys, (list->count + 1) * sizeof *keys);
    if (!keys) return false;
    list->keys = keys;
    keys[list->count] = key;
  }
  items[list->count++] = *item;
  return true;
}

static bool parse_container(cursor *c, json *out, int depth) {
  bool object = *c->at == '{';
  char close = object ? '}' : ']';
  out->kind = object ? J_OBJECT : J_ARRAY;
  c->at++;
  skip_space(c);
  if (c->at < c->end && *c->at == close) {
    c->at++;
    return true;
  }
  for (;;) {
    char *key = NULL;
    json item = {0};
    skip_space(c);
    if (object) {
      if (!parse_string(c, &key)) return false;
      skip_space(c);
      if (c->at >= c->end || *c->at != ':') {
        free(key);
        return false;
      }
      c->at++;
    }
    if (!parse_value(c, &item, depth + 1) || !append(out, &item, key)) {
      free(key);
      json_free(&item);
      return false;
    }
    skip_space(c);
    if (c->at < c->end && *c->at == ',') {
      c->at++;
      continue;
    }
    if (c->at < c->end && *c->at == close) {
      c->at++;
      return true;
    }
    return false;
  }
}

static bool skip_digits(cursor *c) {
  const char *start = c->at;
  while (c->at < c->end && *c->at >= '0' && *c->at <= '9') c->at++;
  return c->at > start;
}

static bool parse_literal(cursor *c, const char *word) {
  size_t n = strlen(word);
  if ((size_t)(c->end - c->at) < n || memcmp(c->at, word, n) != 0) return false;
  c->at += n;
  return true;
}

static bool parse_value(cursor *c, json *out, int depth) {
  skip_space(c);
  if (c->at >= c->end || depth > 16) return false;
  char ch = *c->at;
  if (ch == '{' || ch == '[') return parse_container(c, out, depth);
  if (ch == '"') {
    out->kind = J_STRING;
    return parse_string(c, &out->text);
  }
  if (ch == 'n') return out->kind = J_NULL, parse_literal(c, "null");
  if (ch == 't') return out->kind = J_BOOL, parse_literal(c, "true");
  if (ch == 'f') return out->kind = J_BOOL, parse_literal(c, "false");
  const char *start = c->at;
  if (c->at < c->end && *c->at == '-') c->at++;
  if (!skip_digits(c)) return false;
  if (*start == '0' || (*start == '-' && start[1] == '0')) {
    if (c->at - start > (*start == '-' ? 2 : 1)) return false;
  }
  if (c->at < c->end && *c->at == '.') {
    c->at++;
    if (!skip_digits(c)) return false;
  }
  if (c->at < c->end && (*c->at == 'e' || *c->at == 'E')) {
    c->at++;
    if (c->at < c->end && (*c->at == '+' || *c->at == '-')) c->at++;
    if (!skip_digits(c)) return false;
  }
  out->kind = J_NUMBER;
  out->text = strndup(start, (size_t)(c->at - start));
  return out->text != NULL;
}

static const json *member(const json *object, const char *key) {
  for (size_t i = 0; i < object->count; i++)
    if (strcmp(object->keys[i], key) == 0) return &object->items[i];
  return NULL;
}

static bool whole_number(const json *v, uint64_t *out) {
  if (!v || v->kind != J_NUMBER || v->text[0] < '0' || v->text[0] > '9') return false;
  char *end;
  errno = 0;
  unsigned long long n = strtoull(v->text, &end, 10);
  if (errno || *end) return false;
  *out = n;
  return true;
}

typedef struct {
  uint64_t dev_id;
  char **roots;
  size_t *lengths;
  bool *hit;
  size_t count;
  char uuid[40];
  uint64_t last;
  bool replaying;
  bool replayed_dirty;
  bool replay_purged;
  FSEventStreamRef stream;
} device;

#define MAX_RECORD_BYTES (4u << 20)
#define MAX_ROOTS 1024
#define MAX_HISTORY_AGE_SECONDS 7200
#define RESERVED_DESCRIPTORS 64

static dispatch_queue_t queue;
static CFTimeInterval latency_seconds;
static uint64_t generation;
static rlim_t descriptor_limit;
static device *devices;
static size_t device_count;

static void end_line(void) {
  if (fputs("}\n", stdout) == EOF || fflush(stdout) == EOF) exit(74);
}

static void begin_line(const device *d) {
  printf("{\"generation\":%" PRIu64 ",\"dev\":%" PRIu64, generation, d->dev_id);
}

static void print_uuid(const device *d) {
  if (d->uuid[0]) printf(",\"uuid\":\"%s\"", d->uuid);
  else fputs(",\"uuid\":null", stdout);
}

static void emit_purged(const device *d, const char *reason) {
  begin_line(d);
  printf(",\"purged\":\"%s\"", reason);
  print_uuid(d);
  printf(",\"eventId\":%" PRIu64, d->last);
  end_line();
}

static void emit_history_done(const device *d) {
  begin_line(d);
  fputs(",\"historyDone\":true", stdout);
  print_uuid(d);
  printf(",\"eventId\":%" PRIu64, d->last);
  end_line();
}

static void emit_dirty(const device *d) {
  begin_line(d);
  fputs(",\"dirty\":[", stdout);
  bool first = true;
  for (size_t r = 0; r < d->count; r++) {
    if (!d->hit[r]) continue;
    printf(first ? "%zu" : ",%zu", r);
    first = false;
  }
  printf("],\"eventId\":%" PRIu64, d->last);
  end_line();
}

static bool covers(const device *d, size_t r, const char *path, bool subtree) {
  const char *root = d->roots[r];
  size_t root_length = d->lengths[r];
  size_t length = strlen(path);
  while (length > 1 && path[length - 1] == '/') length--;
  if (length >= root_length && strncmp(path, root, root_length) == 0 &&
      (length == root_length || path[root_length] == '/' || root_length == 1))
    return true;
  return subtree && root_length > length && strncmp(root, path, length) == 0 &&
         (root[length] == '/' || length == 1);
}

static void on_events(ConstFSEventStreamRef stream, void *info, size_t count, void *raw_paths,
                      const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
  device *d = info;
  char **paths = raw_paths;
  const char *purged = NULL;
  bool dirty = false, history_done = false;
  if (!d->replaying) memset(d->hit, 0, d->count * sizeof *d->hit);
  for (size_t i = 0; i < count; i++) {
    if (flags[i] & kFSEventStreamEventFlagHistoryDone) {
      history_done = true;
      continue;
    }
    if (ids[i] > d->last) d->last = ids[i];
    if (flags[i] & kFSEventStreamEventFlagEventIdsWrapped) purged = "ids-wrapped";
    else if (!purged && (flags[i] & (kFSEventStreamEventFlagUserDropped | kFSEventStreamEventFlagKernelDropped)))
      purged = "dropped";
    bool subtree = flags[i] & kFSEventStreamEventFlagMustScanSubDirs;
    for (size_t r = 0; r < d->count; r++) {
      if (!d->hit[r] && covers(d, r, paths[i], subtree)) d->hit[r] = dirty = true;
    }
  }
  if (d->replaying) d->replayed_dirty |= dirty;
  if (purged && !d->replay_purged) emit_purged(d, purged);
  else if (dirty && !d->replaying) emit_dirty(d);
  if (purged && d->replaying) d->replay_purged = true;
  if (history_done) {
    FSEventStreamEventId latest = FSEventStreamGetLatestEventId(stream);
    if (latest > d->last) d->last = latest;
    if (d->replayed_dirty) emit_dirty(d);
    d->replaying = d->replay_purged = false;
    emit_history_done(d);
  }
}

static void stop_all(void) {
  for (size_t i = 0; i < device_count; i++) {
    device *d = &devices[i];
    if (d->stream) {
      FSEventStreamStop(d->stream);
      FSEventStreamInvalidate(d->stream);
      FSEventStreamRelease(d->stream);
    }
    for (size_t r = 0; r < d->count; r++) free(d->roots[r]);
    free(d->roots);
    free(d->lengths);
    free(d->hit);
  }
  free(devices);
  devices = NULL;
  device_count = 0;
}

static void read_uuid(device *d) {
  CFUUIDRef uuid = FSEventsCopyUUIDForDevice((dev_t)d->dev_id);
  if (!uuid) return;
  CFStringRef text = CFUUIDCreateString(NULL, uuid);
  CFStringGetCString(text, d->uuid, sizeof d->uuid, kCFStringEncodingASCII);
  CFRelease(text);
  CFRelease(uuid);
}

static void start(device *d, const json *entry) {
  read_uuid(d);
  const json *uuid_value = member(entry, "uuid");
  uint64_t since = 0, since_at = 0;
  uint64_t now = (uint64_t)time(NULL);
  FSEventStreamEventId current = FSEventsGetCurrentEventId();
  const char *purged = NULL;
  if (!whole_number(member(entry, "since"), &since) || since == 0) purged = "no-since";
  else if (!d->uuid[0]) purged = "no-uuid";
  else if (!uuid_value || uuid_value->kind != J_STRING || strcasecmp(uuid_value->text, d->uuid) != 0)
    purged = "uuid-changed";
  else if (since > current) purged = "id-ahead";
  else if (!whole_number(member(entry, "sinceAt"), &since_at) || since_at > now ||
           now - since_at > MAX_HISTORY_AGE_SECONDS)
    purged = "too-old";
  d->last = purged ? current : since;

  CFMutableArrayRef paths = CFArrayCreateMutable(NULL, (CFIndex)d->count, &kCFTypeArrayCallBacks);
  for (size_t r = 0; r < d->count; r++) {
    CFStringRef path = CFStringCreateWithFileSystemRepresentation(NULL, d->roots[r]);
    if (!path) {
      fprintf(stderr, "stim-fsevents: root %zu is not valid UTF-8.\n", r);
      exit(65);
    }
    CFArrayAppendValue(paths, path);
    CFRelease(path);
  }
  FSEventStreamContext context = {.info = d};
  FSEventStreamEventId since_when = d->uuid[0] ? d->last : kFSEventStreamEventIdSinceNow;
  d->replaying = since_when != kFSEventStreamEventIdSinceNow;
  d->stream = FSEventStreamCreate(NULL, on_events, &context, paths, since_when, latency_seconds,
                                  kFSEventStreamCreateFlagFullHistory | kFSEventStreamCreateFlagWatchRoot);
  CFRelease(paths);
  if (!d->stream) {
    fprintf(stderr, "stim-fsevents: could not create a stream for device %" PRIu64 ".\n", d->dev_id);
    exit(70);
  }
  FSEventStreamSetDispatchQueue(d->stream, queue);
  if (!FSEventStreamStart(d->stream)) {
    fprintf(stderr, "stim-fsevents: could not start the stream for device %" PRIu64 ".\n", d->dev_id);
    exit(70);
  }
  if (purged) emit_purged(d, purged);
  if (since_when == kFSEventStreamEventIdSinceNow) emit_history_done(d);
}

static bool load_device(device *d, const json *entry) {
  const json *roots = member(entry, "roots");
  if (!whole_number(member(entry, "dev"), &d->dev_id) || !roots || roots->kind != J_ARRAY) return false;
  if (roots->count > MAX_ROOTS) {
    fprintf(stderr, "stim-fsevents: a device watches at most %d roots; got %zu.\n", MAX_ROOTS, roots->count);
    exit(65);
  }
  d->count = roots->count;
  d->roots = calloc(d->count + 1, sizeof *d->roots);
  d->lengths = calloc(d->count + 1, sizeof *d->lengths);
  d->hit = calloc(d->count + 1, sizeof *d->hit);
  if (!d->roots || !d->lengths || !d->hit) return false;
  for (size_t r = 0; r < d->count; r++) {
    const json *root = &roots->items[r];
    if (root->kind != J_STRING || root->text[0] != '/') return false;
    size_t length = strlen(root->text);
    while (length > 1 && root->text[length - 1] == '/') length--;
    d->roots[r] = strndup(root->text, length);
    if (!d->roots[r]) return false;
    d->lengths[r] = length;
  }
  return true;
}

/* kFSEventStreamCreateFlagWatchRoot keeps descriptors open on the ancestors
   of every root: measured as one per path component plus three per root. */
static uint64_t watch_root_descriptors(const char *root) {
  uint64_t count = 3;
  for (const char *at = root; *at; at++) count += *at == '/';
  return count;
}

static void handle_line(const char *line, size_t length) {
  cursor c = {line, line + length};
  json message = {0};
  skip_space(&c);
  if (c.at == c.end) return;
  bool ok = parse_value(&c, &message, 0);
  skip_space(&c);
  const json *watch = ok && c.at == c.end && message.kind == J_OBJECT ? member(&message, "watch") : NULL;
  if (!watch || watch->kind != J_ARRAY || !whole_number(member(&message, "generation"), &generation)) {
    fprintf(stderr, "stim-fsevents: expected a {\"generation\": N, \"watch\": [...]} line.\n");
    exit(65);
  }
  stop_all();
  devices = calloc(watch->count + 1, sizeof *devices);
  if (!devices) exit(70);
  device_count = watch->count;
  uint64_t descriptors = RESERVED_DESCRIPTORS;
  for (size_t i = 0; i < watch->count; i++) {
    if (watch->items[i].kind != J_OBJECT || !load_device(&devices[i], &watch->items[i])) {
      fprintf(stderr, "stim-fsevents: watch entry %zu needs a dev number and an array of absolute roots.\n", i);
      exit(65);
    }
    for (size_t j = 0; j < i; j++) {
      if (devices[j].dev_id == devices[i].dev_id) {
        fprintf(stderr, "stim-fsevents: device %" PRIu64 " appears twice in one watch line.\n", devices[i].dev_id);
        exit(65);
      }
    }
    for (size_t r = 0; r < devices[i].count; r++) descriptors += watch_root_descriptors(devices[i].roots[r]);
  }
  bool fits = descriptors <= descriptor_limit;
  for (size_t i = 0; i < device_count; i++) {
    device *d = &devices[i];
    if (d->count == 0) continue;
    if (fits) {
      start(d, &watch->items[i]);
      continue;
    }
    read_uuid(d);
    d->last = FSEventsGetCurrentEventId();
    emit_purged(d, "fd-limit");
  }
  if (!fits)
    fprintf(stderr, "stim-fsevents: the watch needs about %" PRIu64 " file descriptors; the limit is %llu.\n",
            descriptors, (unsigned long long)descriptor_limit);
  json_free(&message);
}

static char *input;
static size_t input_used, input_size;
static bool input_is_file;

static void on_input(void *context) {
  (void)context;
  if (input_size - input_used < 65536) {
    input_size = input_size * 2 + 65536;
    input = realloc(input, input_size);
    if (!input) exit(70);
  }
  ssize_t n = read(STDIN_FILENO, input + input_used, input_size - input_used);
  if (n == 0) exit(0);
  if (input_is_file) dispatch_async_f(queue, NULL, on_input);
  if (n < 0) {
    if (errno == EINTR || errno == EAGAIN) return;
    exit(74);
  }
  input_used += (size_t)n;
  char *start = input;
  char *newline;
  while ((newline = memchr(start, '\n', input_used - (size_t)(start - input)))) {
    if ((size_t)(newline - start) > MAX_RECORD_BYTES) {
      fprintf(stderr, "stim-fsevents: an input line is longer than %u bytes.\n", MAX_RECORD_BYTES);
      exit(65);
    }
    handle_line(start, (size_t)(newline - start));
    start = newline + 1;
  }
  input_used -= (size_t)(start - input);
  memmove(input, start, input_used);
  if (input_used > MAX_RECORD_BYTES) {
    fprintf(stderr, "stim-fsevents: an input line is longer than %u bytes.\n", MAX_RECORD_BYTES);
    exit(65);
  }
}

int main(int argc, char **argv) {
  char *end = NULL;
  latency_seconds = argc == 2 ? strtod(argv[1], &end) : 0;
  if (argc != 2 || *end || !(latency_seconds > 0 && latency_seconds <= 3600)) {
    fprintf(stderr, "usage: stim-fsevents <latency-seconds>\n");
    return 64;
  }
  signal(SIGPIPE, SIG_IGN);
  /* Past the descriptor limit FSEvents stops reporting root changes without
     an error, and launchd's default soft limit is 256. */
  struct rlimit files;
  if (getrlimit(RLIMIT_NOFILE, &files) != 0) {
    fprintf(stderr, "stim-fsevents: could not read the file descriptor limit.\n");
    return 70;
  }
  int per_process = 0;
  size_t per_process_size = sizeof per_process;
  if (sysctlbyname("kern.maxfilesperproc", &per_process, &per_process_size, NULL, 0) != 0) per_process = 0;
  rlim_t wanted = files.rlim_max;
  if (per_process > 0 && (rlim_t)per_process < wanted) wanted = (rlim_t)per_process;
  if (per_process > 0 && files.rlim_cur < wanted) {
    files.rlim_cur = wanted;
    if (setrlimit(RLIMIT_NOFILE, &files) != 0 && wanted > OPEN_MAX) {
      files.rlim_cur = OPEN_MAX;
      setrlimit(RLIMIT_NOFILE, &files);
    }
  }
  if (getrlimit(RLIMIT_NOFILE, &files) != 0) return 70;
  descriptor_limit = files.rlim_cur;
  if (per_process <= 0) descriptor_limit = 0;
  else if ((rlim_t)per_process < descriptor_limit) descriptor_limit = (rlim_t)per_process;
  struct stat input_stat;
  input_is_file = fstat(STDIN_FILENO, &input_stat) == 0 && S_ISREG(input_stat.st_mode);
  queue = dispatch_queue_create("dev.stim.fsevents", DISPATCH_QUEUE_SERIAL);
  dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, queue);
  dispatch_source_set_event_handler_f(source, on_input);
  dispatch_resume(source);
  dispatch_main();
}
