// ignore_for_file: deprecated_member_use
// ignore: avoid_web_libraries_in_flutter
import 'dart:html' as html;

String? getItem(String key) => html.window.localStorage[key];

void setItem(String key, String value) {
  html.window.localStorage[key] = value;
}
