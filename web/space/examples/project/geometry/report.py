"""A line of text about some shapes."""
from .shapes import Circle, Square, total_area


def sample():
    return [Circle(1), Circle(2).scaled(0.5), Square(3)]


def summary(shapes=None):
    shapes = sample() if shapes is None else shapes
    return f"{len(shapes)} shapes, {total_area(shapes):.2f} in all"
