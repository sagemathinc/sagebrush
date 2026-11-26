"""Two shapes, and the area they cover together."""
from math import pi


class Circle:
    def __init__(self, r):
        self.r = r

    def area(self):
        return pi * self.r ** 2

    def scaled(self, k):
        return Circle(self.r * k)


class Square:
    def __init__(self, side):
        self.side = side

    def area(self):
        return self.side ** 2


def total_area(shapes):
    return sum(s.area() for s in shapes)
