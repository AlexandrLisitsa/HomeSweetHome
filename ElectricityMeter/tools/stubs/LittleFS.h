// An in-memory stand-in for LittleFS, for src/persist.cpp on a PC. The test
// reaches the files directly, to corrupt them or to make a step fail.
#pragma once

#include <map>
#include <string>
#include <vector>

#include "Arduino.h"

struct FsStub;
extern FsStub LittleFS;

class File {
 public:
  File() {}
  File(std::vector<uint8_t>* data, bool write) : data_(data), write_(write) {}
  explicit operator bool() const { return data_ != nullptr; }
  size_t read(uint8_t* buf, size_t n) {
    size_t left = data_->size() - pos_;
    if (n > left) n = left;
    std::memcpy(buf, data_->data() + pos_, n);
    pos_ += n;
    return n;
  }
  size_t write(const uint8_t* buf, size_t n);
  void close() { data_ = nullptr; }

 private:
  std::vector<uint8_t>* data_ = nullptr;
  bool write_ = false;
  size_t pos_ = 0;
};

struct FsStub {
  bool mounts = true;
  bool failWrite = false;
  bool failRename = false;
  int renames = 0;
  std::map<std::string, std::vector<uint8_t>> files;

  bool begin() { return mounts; }
  File open(const char* path, const char* mode) {
    if (mode[0] == 'w') {
      files[path].clear();
      return File(&files[path], true);
    }
    auto it = files.find(path);
    return it == files.end() ? File() : File(&it->second, false);
  }
  bool rename(const char* from, const char* to) {
    if (failRename || !files.count(from)) return false;
    files[to] = files[from];
    files.erase(from);
    renames++;
    return true;
  }
};

inline size_t File::write(const uint8_t* buf, size_t n) {
  if (!write_ || LittleFS.failWrite) return 0;
  data_->insert(data_->end(), buf, buf + n);
  return n;
}
