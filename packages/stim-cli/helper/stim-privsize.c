// Prints "<allocated> <private> <files>" for each tree named on the command line: the bytes its regular files occupy
// and the bytes deleting the tree would free. APFS reports a file's unshared bytes as ATTR_CMNEXT_PRIVATESIZE
// (sys/attr.h, requested with FSOPT_ATTR_CMN_EXTENDED); a copy-on-write clone shares its blocks and reports 0. A file
// with more links than the tree holds is shared with a path outside it (a package store's hard links) and frees
// nothing. Symbolic links are not followed. The exit status is 2 when the volume does not report private sizes.

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/types.h>
#include <sys/vnode.h>
#include <unistd.h>

#define BUFFER_SIZE (64 * 1024)
#define MAX_DEPTH 256

struct inode {
  uint64_t id;
  uint64_t allocated;
  uint64_t private_size;
  uint32_t links;
  uint32_t seen;
};

struct totals {
  uint64_t allocated;
  uint64_t files;
  struct inode *linked;
  size_t linked_count;
  size_t linked_capacity;
  int unsupported;
};

static void add_linked(struct totals *totals, uint64_t id, uint32_t links, uint64_t allocated, uint64_t private_size) {
  for (size_t i = 0; i < totals->linked_count; i++) {
    if (totals->linked[i].id == id) {
      totals->linked[i].seen++;
      return;
    }
  }
  if (totals->linked_count == totals->linked_capacity) {
    totals->linked_capacity = totals->linked_capacity ? totals->linked_capacity * 2 : 256;
    totals->linked = realloc(totals->linked, totals->linked_capacity * sizeof *totals->linked);
    if (!totals->linked) exit(1);
  }
  totals->allocated += allocated;
  totals->files++;
  totals->linked[totals->linked_count++] = (struct inode){id, allocated, private_size, links, 1};
}

static uint64_t private_total = 0;

static int walk(int dirfd, struct totals *totals, char *buffer, int depth) {
  struct attrlist request = {0};
  request.bitmapcount = ATTR_BIT_MAP_COUNT;
  request.commonattr = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_ERROR | ATTR_CMN_OBJTYPE | ATTR_CMN_FILEID;
  request.fileattr = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE;
  request.forkattr = ATTR_CMNEXT_PRIVATESIZE;
  for (;;) {
    int count = getattrlistbulk(dirfd, &request, buffer, BUFFER_SIZE, FSOPT_ATTR_CMN_EXTENDED);
    if (count < 0) return -1;
    if (count == 0) return 0;
    char *entry = buffer;
    for (int i = 0; i < count; i++) {
      char *field = entry;
      uint32_t length = *(uint32_t *)field;
      field += sizeof(uint32_t);
      attribute_set_t returned = *(attribute_set_t *)field;
      field += sizeof(attribute_set_t);
      uint32_t error = 0;
      if (returned.commonattr & ATTR_CMN_ERROR) {
        error = *(uint32_t *)field;
        field += sizeof(uint32_t);
      }
      attrreference_t name_ref = *(attrreference_t *)field;
      char *name = field + name_ref.attr_dataoffset;
      field += sizeof(attrreference_t);
      fsobj_type_t type = *(fsobj_type_t *)field;
      field += sizeof(fsobj_type_t);
      uint64_t id = *(uint64_t *)field;
      field += sizeof(uint64_t);
      if (error == 0 && type == VDIR) {
        if (depth + 1 >= MAX_DEPTH) {
          errno = ELOOP;
          return -1;
        }
        int child = openat(dirfd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (child < 0) return -1;
        int walked = walk(child, totals, buffer + BUFFER_SIZE, depth + 1);
        close(child);
        if (walked < 0) return -1;
      } else if (error == 0 && type == VREG) {
        uint32_t links = 1;
        uint64_t allocated = 0, private_size = 0;
        if (returned.fileattr & ATTR_FILE_LINKCOUNT) {
          links = *(uint32_t *)field;
          field += sizeof(uint32_t);
        }
        if (returned.fileattr & ATTR_FILE_ALLOCSIZE) {
          allocated = (uint64_t) * (off_t *)field;
          field += sizeof(off_t);
        }
        if (returned.forkattr & ATTR_CMNEXT_PRIVATESIZE) private_size = (uint64_t) * (off_t *)field;
        else totals->unsupported = 1;
        if (links > 1) add_linked(totals, id, links, allocated, private_size);
        else {
          totals->allocated += allocated;
          totals->files++;
          private_total += private_size;
        }
      }
      entry += length;
    }
  }
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("usage: stim-privsize <dir>...\n", stderr);
    return 64;
  }
  char *buffers = malloc((size_t)BUFFER_SIZE * MAX_DEPTH);
  if (!buffers) return 1;
  int unsupported = 0;
  for (int i = 1; i < argc; i++) {
    struct totals totals = {0};
    private_total = 0;
    int dirfd = open(argv[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dirfd < 0) {
      fprintf(stderr, "%s: %s\n", argv[i], strerror(errno));
      return 1;
    }
    if (walk(dirfd, &totals, buffers, 0) < 0) {
      fprintf(stderr, "%s: %s\n", argv[i], strerror(errno));
      return 1;
    }
    close(dirfd);
    for (size_t j = 0; j < totals.linked_count; j++)
      if (totals.linked[j].seen >= totals.linked[j].links) private_total += totals.linked[j].private_size;
    free(totals.linked);
    if (totals.unsupported) unsupported = 1;
    printf("%llu %llu %llu\n", (unsigned long long)totals.allocated, (unsigned long long)private_total,
           (unsigned long long)totals.files);
  }
  free(buffers);
  return unsupported ? 2 : 0;
}
