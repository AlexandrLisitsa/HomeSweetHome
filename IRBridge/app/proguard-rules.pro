# Ktor + kotlinx.serialization need a little help if you ever turn on minify.
-keep class io.ktor.** { *; }
-keep class kotlinx.coroutines.** { *; }
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class ua.pp.homesweeethome.irbridge.**$$serializer { *; }
-keepclassmembers class ua.pp.homesweeethome.irbridge.** {
    *** Companion;
}
-dontwarn org.slf4j.**
-dontwarn java.lang.management.**
