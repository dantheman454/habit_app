final Map<String, String> _memStorage = <String, String>{};

String? getItem(String key) => _memStorage[key];

void setItem(String key, String value) {
  _memStorage[key] = value;
}
