/*
 * dt-introspect: dump darktable image-operation (iop) parameter introspection
 * as JSON, straight from the installed module binaries.
 *
 * darktable compiles a machine-readable description of every module's params
 * struct into the module itself (DT_MODULE_INTROSPECTION). This helper dlopens
 * each plugin, calls introspection_init() with a dummy module handle and walks
 * get_introspection_linear(), so Chengying discovers every module, field,
 * type, offset, range, default and enum value of the exact darktable build the
 * user has installed — new modules and parameters appear automatically.
 *
 * The struct layouts below mirror src/common/introspection.h with
 * DT_INTROSPECTION_VERSION 8 (darktable 3.x … 5.x). A module built with a
 * different API version is reported as {"error":"api-version"} and skipped.
 *
 * Build: cc -O1 -o dt-introspect dt-introspect.c (-ldl on glibc < 2.34)
 * Usage: dt-introspect <plugin-dir> [module-name ...]   → JSON on stdout
 *
 * Each module is probed in a forked child (POSIX) so a crashing plugin cannot
 * take the whole dump down.
 */
#include <dlfcn.h>
#include <dirent.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <float.h>
#include <limits.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <complex.h>

#define API_VERSION 8

typedef int gboolean;

typedef enum {
  T_NONE = 0, T_OPAQUE, T_FLOAT, T_DOUBLE, T_FLOATCOMPLEX, T_CHAR, T_INT8, T_UINT8, T_SHORT, T_USHORT,
  T_INT, T_UINT, T_LONG, T_ULONG, T_BOOL, T_ARRAY, T_ENUM, T_STRUCT, T_UNION
} itype_t;

typedef struct {
  itype_t type;
  const char *type_name;
  const char *name;
  const char *field_name;
  const char *description;
  size_t size;
  size_t offset;
  void *so;
} header_t;

typedef struct { header_t header; float Min, Max, Default; } t_float;
typedef struct { header_t header; double Min, Max, Default; } t_double;
typedef struct { header_t header; float _Complex Min, Max, Default; } t_fcomplex;
typedef struct { header_t header; char Min, Max, Default; } t_char;
typedef struct { header_t header; int8_t Min, Max; char Default; } t_int8;
typedef struct { header_t header; uint8_t Min, Max, Default; } t_uint8;
typedef struct { header_t header; short Min, Max, Default; } t_short;
typedef struct { header_t header; unsigned short Min, Max, Default; } t_ushort;
typedef struct { header_t header; int Min, Max, Default; } t_int;
typedef struct { header_t header; unsigned int Min, Max, Default; } t_uint;
typedef struct { header_t header; long Min, Max, Default; } t_long;
typedef struct { header_t header; unsigned long Min, Max, Default; } t_ulong;
typedef struct { header_t header; gboolean Default; } t_bool;
union field_t;
typedef struct { header_t header; size_t count; itype_t type; union field_t *field; } t_array;
typedef struct { const char *name; int value; const char *description; } enum_tuple_t;
typedef struct { header_t header; size_t entries; enum_tuple_t *values; int Default; } t_enum;
typedef struct { header_t header; size_t entries; union field_t **fields; } t_struct;

typedef union field_t {
  header_t header;
  t_float Float; t_double Double; t_fcomplex FloatComplex; t_char Char; t_int8 Int8; t_uint8 UInt8;
  t_short Short; t_ushort UShort; t_int Int; t_uint UInt; t_long Long; t_ulong ULong; t_bool Bool;
  t_array Array; t_enum Enum; t_struct Struct; t_struct Union;
} field_t;

typedef struct {
  int api_version;
  int params_version;
  const char *type_name;
  size_t size;
  field_t *field;
  size_t self_size;
  size_t default_params;
} introspection_t;

static void json_str(const char *s) {
  if (!s) { fputs("null", stdout); return; }
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    switch (*p) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*p < 0x20) printf("\\u%04x", *p);
        else putchar(*p);
    }
  }
  putchar('"');
}

static void json_num(double v) {
  if (v != v) { fputs("null", stdout); return; }
  if (v >= FLT_MAX * 0.99 || v >= 1e30) { fputs("\"+max\"", stdout); return; }
  if (v <= -FLT_MAX * 0.99 || v <= -1e30) { fputs("\"-max\"", stdout); return; }
  printf("%.9g", v);
}

static const char *type_label(itype_t t) {
  static const char *names[] = { "none", "opaque", "float", "double", "float_complex", "char", "int8", "uint8", "short",
                                 "ushort", "int", "uint", "long", "ulong", "bool", "array", "enum", "struct", "union" };
  return (t >= 0 && t <= T_UNION) ? names[t] : "unknown";
}

static void dump_field(field_t *f, int depth);

static void dump_field_body(field_t *f, int depth) {
  header_t *h = &f->header;
  printf("\"type\":"); json_str(type_label(h->type));
  printf(",\"typeName\":"); json_str(h->type_name);
  printf(",\"name\":"); json_str(h->name);
  printf(",\"field\":"); json_str(h->field_name);
  printf(",\"description\":"); json_str(h->description);
  printf(",\"size\":%zu,\"offset\":%zu", h->size, h->offset);
  switch (h->type) {
    case T_FLOAT: printf(",\"min\":"); json_num(f->Float.Min); printf(",\"max\":"); json_num(f->Float.Max); printf(",\"default\":"); json_num(f->Float.Default); break;
    case T_DOUBLE: printf(",\"min\":"); json_num(f->Double.Min); printf(",\"max\":"); json_num(f->Double.Max); printf(",\"default\":"); json_num(f->Double.Default); break;
    case T_CHAR: printf(",\"min\":%d,\"max\":%d,\"default\":%d", f->Char.Min, f->Char.Max, f->Char.Default); break;
    case T_INT8: printf(",\"min\":%d,\"max\":%d,\"default\":%d", f->Int8.Min, f->Int8.Max, f->Int8.Default); break;
    case T_UINT8: printf(",\"min\":%u,\"max\":%u,\"default\":%u", f->UInt8.Min, f->UInt8.Max, f->UInt8.Default); break;
    case T_SHORT: printf(",\"min\":%d,\"max\":%d,\"default\":%d", f->Short.Min, f->Short.Max, f->Short.Default); break;
    case T_USHORT: printf(",\"min\":%u,\"max\":%u,\"default\":%u", f->UShort.Min, f->UShort.Max, f->UShort.Default); break;
    case T_INT: printf(",\"min\":%d,\"max\":%d,\"default\":%d", f->Int.Min, f->Int.Max, f->Int.Default); break;
    case T_UINT: printf(",\"min\":%u,\"max\":%u,\"default\":%u", f->UInt.Min, f->UInt.Max, f->UInt.Default); break;
    case T_LONG: printf(",\"min\":%ld,\"max\":%ld,\"default\":%ld", f->Long.Min, f->Long.Max, f->Long.Default); break;
    case T_ULONG: printf(",\"min\":%lu,\"max\":%lu,\"default\":%lu", f->ULong.Min, f->ULong.Max, f->ULong.Default); break;
    case T_BOOL: printf(",\"default\":%s", f->Bool.Default ? "true" : "false"); break;
    case T_ENUM:
      printf(",\"default\":%d,\"values\":[", f->Enum.Default);
      if (f->Enum.values) {
        for (size_t i = 0; f->Enum.values[i].name && i < 4096; i++) {
          if (i) putchar(',');
          printf("{\"name\":"); json_str(f->Enum.values[i].name);
          printf(",\"value\":%d,\"description\":", f->Enum.values[i].value); json_str(f->Enum.values[i].description);
          putchar('}');
        }
      }
      putchar(']');
      break;
    case T_ARRAY:
      printf(",\"count\":%zu,\"elementType\":", f->Array.count); json_str(type_label(f->Array.type));
      if (f->Array.field && depth < 8) { printf(",\"element\":"); dump_field(f->Array.field, depth + 1); }
      break;
    case T_STRUCT:
    case T_UNION:
      printf(",\"fields\":[");
      if (f->Struct.fields && depth < 8) {
        for (size_t i = 0; i < f->Struct.entries && f->Struct.fields[i]; i++) {
          if (i) putchar(',');
          dump_field(f->Struct.fields[i], depth + 1);
        }
      }
      putchar(']');
      break;
    default: break;
  }
}

static void dump_field(field_t *f, int depth) {
  putchar('{');
  dump_field_body(f, depth);
  putchar('}');
}

typedef int (*int_fn)(void);
typedef int (*cs_fn)(void *, void *, void *);

/* Call a colorspace query with NULL module/pipe arguments in a throw-away child:
 * most modules answer with a constant, a few dereference the module and would
 * crash — those are reported as unknown (-99) instead of aborting the dump. */
static int guarded_cs(cs_fn fn) {
  if (!fn) return -98;
  int fds[2];
  if (pipe(fds) != 0) return -97;
  pid_t pid = fork();
  if (pid == 0) {
    close(fds[0]);
    int v = fn(NULL, NULL, NULL);
    if (write(fds[1], &v, sizeof v) != sizeof v) _exit(2);
    _exit(0);
  }
  close(fds[1]);
  int v = -99;
  ssize_t r = read(fds[0], &v, sizeof v);
  close(fds[0]);
  int status = 0;
  waitpid(pid, &status, 0);
  if (r != sizeof v || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return -99;
  return v;
}
typedef const char *(*name_fn)(void);
typedef introspection_t *(*intro_fn)(void);
typedef int (*init_fn)(void *, int);

static int probe(const char *path, const char *op) {
  void *h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!h) h = dlopen(path, RTLD_LAZY | RTLD_LOCAL);
  if (!h) {
    printf("{\"operation\":"); json_str(op); printf(",\"error\":"); json_str(dlerror()); printf("}");
    return 1;
  }
  int_fn dt_version = (int_fn)dlsym(h, "dt_module_dt_version");
  int_fn mod_version = (int_fn)dlsym(h, "dt_module_mod_version");
  name_fn name = (name_fn)dlsym(h, "name");
  int_fn group = (int_fn)dlsym(h, "default_group");
  int_fn flags = (int_fn)dlsym(h, "flags");
  intro_fn get_intro = (intro_fn)dlsym(h, "get_introspection");
  init_fn intro_init = (init_fn)dlsym(h, "introspection_init");
  printf("{\"operation\":"); json_str(op);
  if (name) { printf(",\"title\":"); json_str(name()); }
  if (dt_version) printf(",\"apiVersion\":%d", dt_version());
  if (mod_version) printf(",\"moduleVersion\":%d", mod_version());
  if (group) printf(",\"group\":%d", group());
  if (flags) printf(",\"flags\":%d", flags());
  printf(",\"defaultColorspace\":%d", guarded_cs((cs_fn)dlsym(h, "default_colorspace")));
  cs_fn blend_cs = (cs_fn)dlsym(h, "blend_colorspace");
  printf(",\"blendColorspace\":%d", blend_cs ? guarded_cs(blend_cs) : -98);
  if (!get_intro || !intro_init) {
    printf(",\"introspection\":false}");
    return 0;
  }
  static char fake_so[1 << 16];
  if (intro_init(fake_so, API_VERSION) != 0) {
    printf(",\"introspection\":false,\"error\":\"api-version\"}");
    return 0;
  }
  introspection_t *in = get_intro();
  if (!in || !in->field) { printf(",\"introspection\":false}"); return 0; }
  printf(",\"introspection\":true,\"introspectionApi\":%d,\"paramsVersion\":%d,\"paramsType\":", in->api_version, in->params_version);
  json_str(in->type_name);
  printf(",\"paramsSize\":%zu,\"params\":", in->size);
  dump_field(in->field, 0);
  putchar('}');
  return 0;
}

/* Blend params layout version of the installed libdarktable (dt_develop_blend_version()). */
static int probe_blend_version(const char *plugin_path) {
  int fds[2];
  if (pipe(fds) != 0) return -97;
  pid_t pid = fork();
  if (pid == 0) {
    close(fds[0]);
    void *h = dlopen(plugin_path, RTLD_NOW | RTLD_GLOBAL);
    if (!h) h = dlopen(plugin_path, RTLD_LAZY | RTLD_GLOBAL);
    int v = -96;
    if (h) {
      int_fn f = (int_fn)dlsym(RTLD_DEFAULT, "dt_develop_blend_version");
      if (!f) f = (int_fn)dlsym(h, "dt_develop_blend_version");
      v = f ? f() : -95;
    }
    if (write(fds[1], &v, sizeof v) != sizeof v) _exit(2);
    _exit(0);
  }
  close(fds[1]);
  int v = -99;
  ssize_t r = read(fds[0], &v, sizeof v);
  close(fds[0]);
  int status = 0;
  waitpid(pid, &status, 0);
  return r == sizeof v ? v : -99;
}

/* darktable's built-in pipeline orders (dt_ioppr_get_iop_order_list_version), printed as
 * "iopOrders":{"1":"op,inst,...",...}. Entry layout per src/common/iop_order.h. */
typedef struct gl_t { void *data; struct gl_t *next; struct gl_t *prev; } gl_t;
typedef struct { union { double f; int i; } o; char operation[20]; int instance; char name[25]; } order_entry_t;
typedef gl_t *(*order_fn)(int);

static void print_iop_orders(const char *plugin_path) {
  int fds[2];
  if (pipe(fds) != 0) { printf("{}"); return; }
  pid_t pid = fork();
  if (pid == 0) {
    close(fds[0]);
    FILE *out = fdopen(fds[1], "w");
    void *h = dlopen(plugin_path, RTLD_NOW | RTLD_GLOBAL);
    if (!h) h = dlopen(plugin_path, RTLD_LAZY | RTLD_GLOBAL);
    order_fn f = h ? (order_fn)dlsym(RTLD_DEFAULT, "dt_ioppr_get_iop_order_list_version") : NULL;
    fputc('{', out);
    for (int v = 1; f && v <= 5; v++) {
      gl_t *l = f(v);
      if (v > 1) fputc(',', out);
      fprintf(out, "\"%d\":\"", v);
      int first = 1;
      for (gl_t *n = l; n && n->data; n = n->next) {
        order_entry_t *e = (order_entry_t *)n->data;
        char op[21]; memcpy(op, e->operation, 20); op[20] = 0;
        fprintf(out, "%s%s,%d", first ? "" : ",", op, e->instance);
        first = 0;
      }
      fputc('"', out);
    }
    fputc('}', out);
    fclose(out);
    _exit(0);
  }
  close(fds[1]);
  char buf[65536];
  size_t len = 0;
  ssize_t r;
  while ((r = read(fds[0], buf + len, sizeof buf - 1 - len)) > 0) len += (size_t)r;
  close(fds[0]);
  buf[len] = 0;
  int status = 0;
  waitpid(pid, &status, 0);
  if (WIFEXITED(status) && WEXITSTATUS(status) == 0 && len > 1 && buf[0] == '{' && buf[len - 1] == '}') fwrite(buf, 1, len, stdout);
  else printf("{}");
}

static int has_suffix(const char *s, const char *suf) {
  size_t a = strlen(s), b = strlen(suf);
  return a >= b && strcmp(s + a - b, suf) == 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <plugin-dir> [module ...]\n", argv[0]);
    return 2;
  }
  const char *dir = argv[1];
  DIR *d = opendir(dir);
  if (!d) { perror(dir); return 1; }
  struct dirent *e;
  int first = 1;
  char probe_path[4096] = { 0 };
  {
    DIR *pd = opendir(dir);
    struct dirent *pe;
    while (pd && (pe = readdir(pd))) {
      if (strncmp(pe->d_name, "libexposure.", 12) == 0) { snprintf(probe_path, sizeof probe_path, "%s/%s", dir, pe->d_name); break; }
    }
    if (pd) closedir(pd);
  }
  printf("{\"introspectionApi\":%d,\"blendVersion\":%d,\"iopOrders\":", API_VERSION, probe_path[0] ? probe_blend_version(probe_path) : -94);
  if (probe_path[0]) print_iop_orders(probe_path); else printf("{}");
  printf(",\"modules\":[");
  fflush(stdout);
  while ((e = readdir(d))) {
    const char *n = e->d_name;
    if (strncmp(n, "lib", 3) != 0) continue;
    if (!(has_suffix(n, ".so") || has_suffix(n, ".dylib") || has_suffix(n, ".dll"))) continue;
    char op[256];
    snprintf(op, sizeof op, "%s", n + 3);
    char *dot = strrchr(op, '.');
    if (dot) *dot = 0;
    if (argc > 2) {
      int want = 0;
      for (int i = 2; i < argc; i++) if (strcmp(argv[i], op) == 0) want = 1;
      if (!want) continue;
    }
    char path[4096];
    snprintf(path, sizeof path, "%s/%s", dir, n);
    if (!first) putchar(',');
    first = 0;
    fflush(stdout);
    // The child writes into a pipe; only complete output of a cleanly exited
    // child is forwarded, so a crashing plugin cannot corrupt the JSON stream.
    int fds[2];
    if (pipe(fds) != 0) { perror("pipe"); return 1; }
    pid_t pid = fork();
    if (pid == 0) {
      close(fds[0]);
      dup2(fds[1], STDOUT_FILENO);
      int rc = probe(path, op);
      fflush(stdout);
      _exit(rc);
    }
    close(fds[1]);
    size_t cap = 1 << 16, len = 0;
    char *buf = malloc(cap);
    ssize_t r;
    while (buf && (r = read(fds[0], buf + len, cap - len)) > 0) {
      len += (size_t)r;
      if (len == cap) { cap *= 2; buf = realloc(buf, cap); }
    }
    close(fds[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    if (buf && WIFEXITED(status) && len > 0) {
      fwrite(buf, 1, len, stdout);
    } else {
      printf("{\"operation\":"); json_str(op);
      printf(",\"error\":\"%s\"}", WIFSIGNALED(status) ? "crashed" : "no-output");
    }
    free(buf);
    fflush(stdout);
  }
  closedir(d);
  printf("]}\n");
  return 0;
}
