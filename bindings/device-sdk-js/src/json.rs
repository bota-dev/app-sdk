//! Preserve every 64-bit integer across JSON without a JavaScript Number conversion.

use serde::{Deserialize, Serialize, de, ser};
use std::fmt;

#[cfg(test)]
pub fn encode<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&Safe(value))
}

pub fn encode_bounded<T: Serialize + ?Sized>(
    value: &T,
    limit: usize,
) -> Result<Vec<u8>, serde_json::Error> {
    struct Bounded {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl std::io::Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other("JSON output exceeds its bound"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Bounded {
        bytes: Vec::new(),
        limit,
    };
    let mut serializer = serde_json::Serializer::new(&mut output);
    Safe(value).serialize(&mut serializer)?;
    Ok(output.bytes)
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let result = T::deserialize(SafeDeserializer(&mut deserializer))?;
    deserializer.end()?;
    Ok(result)
}

struct Safe<'a, T: ?Sized>(&'a T);

impl<T: Serialize + ?Sized> Serialize for Safe<'_, T> {
    fn serialize<S: ser::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(SafeSerializer(serializer))
    }
}

struct SafeSerializer<S>(S);
struct Compound<C>(C);

macro_rules! scalar_serializer {
    ($($method:ident($type:ty)),* $(,)?) => {$ (
        fn $method(self, value: $type) -> Result<Self::Ok, Self::Error> {
            self.0.$method(value)
        }
    )*};
}

impl<S: ser::Serializer> ser::Serializer for SafeSerializer<S> {
    type Ok = S::Ok;
    type Error = S::Error;
    type SerializeSeq = Compound<S::SerializeSeq>;
    type SerializeTuple = Compound<S::SerializeTuple>;
    type SerializeTupleStruct = Compound<S::SerializeTupleStruct>;
    type SerializeTupleVariant = Compound<S::SerializeTupleVariant>;
    type SerializeMap = Compound<S::SerializeMap>;
    type SerializeStruct = Compound<S::SerializeStruct>;
    type SerializeStructVariant = Compound<S::SerializeStructVariant>;

    scalar_serializer!(
        serialize_bool(bool),
        serialize_i8(i8),
        serialize_i16(i16),
        serialize_i32(i32),
        serialize_u8(u8),
        serialize_u16(u16),
        serialize_u32(u32),
        serialize_f32(f32),
        serialize_f64(f64),
        serialize_char(char),
        serialize_str(&str),
        serialize_bytes(&[u8])
    );

    fn serialize_i64(self, value: i64) -> Result<Self::Ok, Self::Error> {
        self.0.serialize_str(&value.to_string())
    }
    fn serialize_u64(self, value: u64) -> Result<Self::Ok, Self::Error> {
        self.0.serialize_str(&value.to_string())
    }
    fn serialize_none(self) -> Result<Self::Ok, Self::Error> {
        self.0.serialize_none()
    }
    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<Self::Ok, Self::Error> {
        self.0.serialize_some(&Safe(value))
    }
    fn serialize_unit(self) -> Result<Self::Ok, Self::Error> {
        self.0.serialize_unit()
    }
    fn serialize_unit_struct(self, name: &'static str) -> Result<Self::Ok, Self::Error> {
        self.0.serialize_unit_struct(name)
    }
    fn serialize_unit_variant(
        self,
        name: &'static str,
        index: u32,
        variant: &'static str,
    ) -> Result<Self::Ok, Self::Error> {
        self.0.serialize_unit_variant(name, index, variant)
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        name: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Self::Error> {
        self.0.serialize_newtype_struct(name, &Safe(value))
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        name: &'static str,
        index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Self::Error> {
        self.0
            .serialize_newtype_variant(name, index, variant, &Safe(value))
    }
    fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
        self.0.serialize_seq(len).map(Compound)
    }
    fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple, Self::Error> {
        self.0.serialize_tuple(len).map(Compound)
    }
    fn serialize_tuple_struct(
        self,
        name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleStruct, Self::Error> {
        self.0.serialize_tuple_struct(name, len).map(Compound)
    }
    fn serialize_tuple_variant(
        self,
        name: &'static str,
        index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleVariant, Self::Error> {
        self.0
            .serialize_tuple_variant(name, index, variant, len)
            .map(Compound)
    }
    fn serialize_map(self, len: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
        self.0.serialize_map(len).map(Compound)
    }
    fn serialize_struct(
        self,
        name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeStruct, Self::Error> {
        self.0.serialize_struct(name, len).map(Compound)
    }
    fn serialize_struct_variant(
        self,
        name: &'static str,
        index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Self::SerializeStructVariant, Self::Error> {
        self.0
            .serialize_struct_variant(name, index, variant, len)
            .map(Compound)
    }
    fn is_human_readable(&self) -> bool {
        self.0.is_human_readable()
    }
}

macro_rules! sequence_serializer {
    ($trait:ident, $method:ident) => {
        impl<C: ser::$trait> ser::$trait for Compound<C> {
            type Ok = C::Ok;
            type Error = C::Error;
            fn $method<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Self::Error> {
                self.0.$method(&Safe(value))
            }
            fn end(self) -> Result<Self::Ok, Self::Error> {
                self.0.end()
            }
        }
    };
}
sequence_serializer!(SerializeSeq, serialize_element);
sequence_serializer!(SerializeTuple, serialize_element);
sequence_serializer!(SerializeTupleStruct, serialize_field);
sequence_serializer!(SerializeTupleVariant, serialize_field);

impl<C: ser::SerializeMap> ser::SerializeMap for Compound<C> {
    type Ok = C::Ok;
    type Error = C::Error;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Self::Error> {
        self.0.serialize_key(&Safe(value))
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Self::Error> {
        self.0.serialize_value(&Safe(value))
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        self.0.end()
    }
}

macro_rules! struct_serializer {
    ($trait:ident) => {
        impl<C: ser::$trait> ser::$trait for Compound<C> {
            type Ok = C::Ok;
            type Error = C::Error;
            fn serialize_field<T: Serialize + ?Sized>(
                &mut self,
                key: &'static str,
                value: &T,
            ) -> Result<(), Self::Error> {
                self.0.serialize_field(key, &Safe(value))
            }
            fn skip_field(&mut self, key: &'static str) -> Result<(), Self::Error> {
                self.0.skip_field(key)
            }
            fn end(self) -> Result<Self::Ok, Self::Error> {
                self.0.end()
            }
        }
    };
}
struct_serializer!(SerializeStruct);
struct_serializer!(SerializeStructVariant);

struct SafeDeserializer<D>(D);
struct SafeVisitor<V>(V);
struct Seed<S>(S);
struct Access<A>(A);

impl<'de, S: de::DeserializeSeed<'de>> de::DeserializeSeed<'de> for Seed<S> {
    type Value = S::Value;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        self.0.deserialize(SafeDeserializer(deserializer))
    }
}

macro_rules! scalar_visitor {
    ($($method:ident($type:ty)),* $(,)?) => {$ (
        fn $method<E: de::Error>(self, value: $type) -> Result<Self::Value, E> {
            self.0.$method(value)
        }
    )*};
}

impl<'de, V: de::Visitor<'de>> de::Visitor<'de> for SafeVisitor<V> {
    type Value = V::Value;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.expecting(formatter)
    }
    scalar_visitor!(
        visit_bool(bool),
        visit_i8(i8),
        visit_i16(i16),
        visit_i32(i32),
        visit_i64(i64),
        visit_u8(u8),
        visit_u16(u16),
        visit_u32(u32),
        visit_u64(u64),
        visit_f32(f32),
        visit_f64(f64),
        visit_char(char),
        visit_str(&str),
        visit_string(String),
        visit_bytes(&[u8]),
        visit_byte_buf(Vec<u8>)
    );
    fn visit_borrowed_str<E: de::Error>(self, value: &'de str) -> Result<Self::Value, E> {
        self.0.visit_borrowed_str(value)
    }
    fn visit_borrowed_bytes<E: de::Error>(self, value: &'de [u8]) -> Result<Self::Value, E> {
        self.0.visit_borrowed_bytes(value)
    }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        self.0.visit_none()
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        self.0.visit_unit()
    }
    fn visit_some<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        self.0.visit_some(SafeDeserializer(deserializer))
    }
    fn visit_newtype_struct<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        self.0.visit_newtype_struct(SafeDeserializer(deserializer))
    }
    fn visit_seq<A: de::SeqAccess<'de>>(self, access: A) -> Result<Self::Value, A::Error> {
        self.0.visit_seq(Access(access))
    }
    fn visit_map<A: de::MapAccess<'de>>(self, access: A) -> Result<Self::Value, A::Error> {
        self.0.visit_map(Access(access))
    }
    fn visit_enum<A: de::EnumAccess<'de>>(self, access: A) -> Result<Self::Value, A::Error> {
        self.0.visit_enum(Access(access))
    }
}

impl<'de, A: de::SeqAccess<'de>> de::SeqAccess<'de> for Access<A> {
    type Error = A::Error;
    fn next_element_seed<S: de::DeserializeSeed<'de>>(
        &mut self,
        seed: S,
    ) -> Result<Option<S::Value>, Self::Error> {
        self.0.next_element_seed(Seed(seed))
    }
    fn size_hint(&self) -> Option<usize> {
        self.0.size_hint()
    }
}
impl<'de, A: de::MapAccess<'de>> de::MapAccess<'de> for Access<A> {
    type Error = A::Error;
    fn next_key_seed<S: de::DeserializeSeed<'de>>(
        &mut self,
        seed: S,
    ) -> Result<Option<S::Value>, Self::Error> {
        self.0.next_key_seed(Seed(seed))
    }
    fn next_value_seed<S: de::DeserializeSeed<'de>>(
        &mut self,
        seed: S,
    ) -> Result<S::Value, Self::Error> {
        self.0.next_value_seed(Seed(seed))
    }
    fn size_hint(&self) -> Option<usize> {
        self.0.size_hint()
    }
}
impl<'de, A: de::EnumAccess<'de>> de::EnumAccess<'de> for Access<A> {
    type Error = A::Error;
    type Variant = Access<A::Variant>;
    fn variant_seed<S: de::DeserializeSeed<'de>>(
        self,
        seed: S,
    ) -> Result<(S::Value, Self::Variant), Self::Error> {
        self.0
            .variant_seed(Seed(seed))
            .map(|(value, variant)| (value, Access(variant)))
    }
}
impl<'de, A: de::VariantAccess<'de>> de::VariantAccess<'de> for Access<A> {
    type Error = A::Error;
    fn unit_variant(self) -> Result<(), Self::Error> {
        self.0.unit_variant()
    }
    fn newtype_variant_seed<S: de::DeserializeSeed<'de>>(
        self,
        seed: S,
    ) -> Result<S::Value, Self::Error> {
        self.0.newtype_variant_seed(Seed(seed))
    }
    fn tuple_variant<V: de::Visitor<'de>>(
        self,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.0.tuple_variant(len, SafeVisitor(visitor))
    }
    fn struct_variant<V: de::Visitor<'de>>(
        self,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.0.struct_variant(fields, SafeVisitor(visitor))
    }
}

struct IntegerVisitor<V> {
    inner: V,
    signed: bool,
}
impl<'de, V: de::Visitor<'de>> de::Visitor<'de> for IntegerVisitor<V> {
    type Value = V::Value;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a canonical decimal string or a safe integer")
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        if self.signed {
            let number: i64 = value.parse().map_err(E::custom)?;
            if number.to_string() != value {
                return Err(E::custom("non-canonical integer"));
            }
            self.inner.visit_i64(number)
        } else {
            let number: u64 = value.parse().map_err(E::custom)?;
            if number.to_string() != value {
                return Err(E::custom("non-canonical integer"));
            }
            self.inner.visit_u64(number)
        }
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        if value > 9_007_199_254_740_991 {
            return Err(E::custom(
                "unsafe JavaScript integer must use a decimal string",
            ));
        }
        self.inner.visit_u64(value)
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        if value.unsigned_abs() > 9_007_199_254_740_991 {
            return Err(E::custom(
                "unsafe JavaScript integer must use a decimal string",
            ));
        }
        self.inner.visit_i64(value)
    }
}

macro_rules! primitive_deserializer {
    ($($method:ident),* $(,)?) => {$ (
        fn $method<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
            self.0.$method(SafeVisitor(visitor))
        }
    )*};
}
impl<'de, D: de::Deserializer<'de>> de::Deserializer<'de> for SafeDeserializer<D> {
    type Error = D::Error;
    primitive_deserializer!(
        deserialize_any,
        deserialize_bool,
        deserialize_i8,
        deserialize_i16,
        deserialize_i32,
        deserialize_u8,
        deserialize_u16,
        deserialize_u32,
        deserialize_f32,
        deserialize_f64,
        deserialize_char,
        deserialize_str,
        deserialize_string,
        deserialize_bytes,
        deserialize_byte_buf,
        deserialize_option,
        deserialize_unit,
        deserialize_seq,
        deserialize_map,
        deserialize_identifier,
        deserialize_ignored_any
    );
    fn deserialize_u64<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        self.0.deserialize_any(IntegerVisitor {
            inner: visitor,
            signed: false,
        })
    }
    fn deserialize_i64<V: de::Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        self.0.deserialize_any(IntegerVisitor {
            inner: visitor,
            signed: true,
        })
    }
    fn deserialize_unit_struct<V: de::Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.0.deserialize_unit_struct(name, SafeVisitor(visitor))
    }
    fn deserialize_newtype_struct<V: de::Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.0
            .deserialize_newtype_struct(name, SafeVisitor(visitor))
    }
    fn deserialize_tuple<V: de::Visitor<'de>>(
        self,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.0.deserialize_tuple(len, SafeVisitor(visitor))
    }
    fn deserialize_tuple_struct<V: de::Visitor<'de>>(
        self,
        name: &'static str,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.0
            .deserialize_tuple_struct(name, len, SafeVisitor(visitor))
    }
    fn deserialize_struct<V: de::Visitor<'de>>(
        self,
        name: &'static str,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.0
            .deserialize_struct(name, fields, SafeVisitor(visitor))
    }
    fn deserialize_enum<V: de::Visitor<'de>>(
        self,
        name: &'static str,
        variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.0
            .deserialize_enum(name, variants, SafeVisitor(visitor))
    }
    fn is_human_readable(&self) -> bool {
        self.0.is_human_readable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    enum Sample {
        Values {
            unsigned: u64,
            signed: i64,
            small: u32,
            nested: Vec<Option<u64>>,
        },
    }
    #[test]
    fn nested_integers_round_trip_without_number_loss() {
        let value = Sample::Values {
            unsigned: u64::MAX,
            signed: i64::MIN,
            small: 17,
            nested: vec![Some(9_007_199_254_740_993), None],
        };
        let bytes = encode(&value).unwrap();
        let document: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(document["Values"]["unsigned"], "18446744073709551615");
        assert_eq!(document["Values"]["small"], 17);
        assert_eq!(decode::<Sample>(&bytes).unwrap(), value);
    }
    #[test]
    fn unsafe_or_noncanonical_integer_inputs_are_rejected() {
        for input in [
            "9007199254740993",
            "\"01\"",
            "\"+1\"",
            "\"18446744073709551616\"",
            "1.5",
        ] {
            assert!(decode::<u64>(input.as_bytes()).is_err(), "{input}");
        }
        assert!(decode::<i64>(b"\"-0\"").is_err());
        assert!(decode::<u64>(b"1 true").is_err());
    }
}
